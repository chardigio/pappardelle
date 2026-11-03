import {Buffer} from 'node:buffer';

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockingKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusInfo {
	status: ProgramState | 'unknown';
	id?: string;
	app?: string;
	kind?: BlockingKind;
	progress?: number;
	title?: string;
	message?: string;
	source?: 'osc' | 'hook';
	generation?: string;
	tool?: string;
	activity?: 'compacting' | 'tool';
}

export interface ProgramReport {
	state: ProgramState | 'clear';
	id: string;
	app?: string;
	kind?: BlockingKind;
	progress?: number;
	title?: string;
	message?: string;
}

const states = new Set([
	'idle',
	'working',
	'done',
	'blocked',
	'error',
	'clear',
]);
const kinds = new Set(['permission', 'question', 'auth']);
const decoder = new TextDecoder('utf-8', {fatal: true});

function decodeText(
	value: string,
	encodedLimit: number,
	decodedLimit: number,
): string {
	if (value.length > encodedLimit || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
		throw new Error('base64');
	const unpadded = value.replace(/=+$/, '');
	if (
		unpadded.length % 4 === 1 ||
		(value.includes('=') && value.length % 4 !== 0)
	)
		throw new Error('base64');
	const bytes = Buffer.from(value, 'base64');
	if (
		bytes.length > decodedLimit ||
		bytes.toString('base64').replace(/=+$/, '') !== unpadded
	)
		throw new Error('base64');
	const result = decoder.decode(bytes);
	if (/[\p{Cc}]/u.test(result)) throw new Error('control character');
	return result;
}

export function parseProgramReport(
	body: string,
	framingBytes = 9,
): ProgramReport | null {
	if (Buffer.byteLength(body) + framingBytes > 4096) return null;
	const values = new Map<string, string>();
	try {
		for (const pair of body.split(':')) {
			const equals = pair.indexOf('=');
			if (equals === -1) continue;
			const key = pair.slice(0, equals).trim();
			const value = pair.slice(equals + 1).trim();
			if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value))
				continue;
			if (key.length > 16) return null;
			if (key === 'app' && value.length > 32) return null;
			if (
				key === 'id' &&
				(value.length > 128 ||
					value.split('/').length > 8 ||
					value
						.split('/')
						.some(segment => !/^[A-Za-z0-9_.+-]{1,32}$/.test(segment)))
			)
				return null;
			if (key === 'msg') decodeText(value, 2732, 2048);
			if (key === 'title') decodeText(value, 256, 192);
			values.set(key, value);
		}
		const state = values.get('state');
		if (!state || !states.has(state)) return null;
		const report: ProgramReport = {
			state: state as ProgramReport['state'],
			id: values.get('id') ?? '',
		};
		const app = values.get('app');
		if (app && /^[A-Za-z0-9_.+-]{1,32}$/.test(app)) report.app = app;
		const kind = values.get('kind');
		if (state === 'blocked' && kind && kinds.has(kind))
			report.kind = kind as BlockingKind;
		const progress = values.get('progress');
		if (
			(state === 'working' || state === 'blocked') &&
			progress &&
			/^\d+$/.test(progress) &&
			Number(progress) <= 100
		)
			report.progress = Number(progress);
		if (values.has('msg'))
			report.message = decodeText(values.get('msg')!, 2732, 2048);
		if (values.has('title'))
			report.title = decodeText(values.get('title')!, 256, 192);
		return report;
	} catch {
		return null;
	}
}

const priority: Record<ProgramStatusInfo['status'], number> = {
	blocked: 5,
	error: 4,
	working: 3,
	done: 2,
	idle: 1,
	unknown: 0,
};

export class ProgramStatusStore {
	authoritative = false;
	private sequence = 0;
	private readonly entries = new Map<
		string,
		{report: ProgramReport; order: number}
	>();

	apply(report: ProgramReport): void {
		this.authoritative = true;
		if (report.state === 'clear') {
			for (const id of this.entries.keys())
				if (!report.id || id === report.id || id.startsWith(`${report.id}/`))
					this.entries.delete(id);
			return;
		}
		if (!this.entries.has(report.id) && this.entries.size >= 256) {
			const oldest = [...this.entries].sort(
				(a, b) => a[1].order - b[1].order,
			)[0]!;
			this.entries.delete(oldest[0]);
		}
		this.entries.set(report.id, {report: {...report}, order: ++this.sequence});
	}

	records(): ProgramReport[] {
		return [...this.entries.values()]
			.sort((a, b) => a.order - b.order)
			.map(entry => ({...entry.report}));
	}

	status(): ProgramStatusInfo {
		const selected = [...this.entries.values()].sort(
			(a, b) =>
				priority[b.report.state as ProgramState] -
					priority[a.report.state as ProgramState] ||
				Number(b.report.id === '') - Number(a.report.id === '') ||
				b.order - a.order ||
				a.report.id.localeCompare(b.report.id),
		)[0];
		if (!selected) return {status: 'unknown'};
		const {state, ...details} = selected.report;
		let {id} = details;
		while (!details.app && id) {
			id = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
			details.app = this.entries.get(id)?.report.app;
		}
		if (details.app === undefined) delete details.app;
		return {status: state as ProgramState, ...details};
	}

	processExit(): void {
		for (const [id, entry] of this.entries)
			if (entry.report.state === 'working' || entry.report.state === 'blocked')
				this.entries.delete(id);
	}

	reset(): void {
		this.entries.clear();
		// Source precedence lasts until pane replacement, including across RIS.
	}
}

export type TerminalStatusEvent =
	| {type: 'report'; report: ProgramReport}
	| {type: 'query' | 'prompt' | 'reset'};

export class TerminalStatusParser {
	private mode:
		| 'text'
		| 'escape'
		| 'osc'
		| 'osc-escape'
		| 'string'
		| 'string-escape' = 'text';

	private body: number[] = [];
	private oversized = false;
	private stringKind = '';

	constructor(private readonly emit: (event: TerminalStatusEvent) => void) {}

	get bufferedBytes(): number {
		return this.body.length;
	}

	feed(bytes: Uint8Array): void {
		for (const byte of bytes) this.consume(byte);
	}

	private append(byte: number): void {
		const limit =
			this.stringKind === 'dcs' && this.mode.startsWith('string') ? 4101 : 4096;
		if (this.body.length < limit) this.body.push(byte);
		else this.oversized = true;
	}

	private finishOsc(terminatorBytes: number): void {
		if (!this.oversized && this.body.length + 2 + terminatorBytes <= 4096) {
			const value = Buffer.from(this.body).toString('ascii');
			if (value === '7501;?') this.emit({type: 'query'});
			else if (/^133;A(?:;|$)/.test(value)) this.emit({type: 'prompt'});
			else if (value.startsWith('7501;')) {
				const report = parseProgramReport(value.slice(5), 7 + terminatorBytes);
				if (report) this.emit({type: 'report', report});
			}
		}
		this.body = [];
		this.oversized = false;
		this.mode = 'text';
	}

	private consume(byte: number): void {
		if (byte === 0x18 || byte === 0x1a) {
			this.mode = 'text';
			this.body = [];
			this.oversized = false;
			return;
		}
		switch (this.mode) {
			case 'text': {
				if (byte === 0x1b) this.mode = 'escape';
				break;
			}
			case 'escape': {
				this.body = [];
				this.oversized = false;
				if (byte === 0x5d) this.mode = 'osc';
				else if ([0x50, 0x58, 0x5e, 0x5f].includes(byte)) {
					this.mode = 'string';
					this.stringKind = byte === 0x50 ? 'dcs' : 'opaque';
				} else {
					if (byte === 0x63) this.emit({type: 'reset'});
					this.mode = byte === 0x1b ? 'escape' : 'text';
				}
				break;
			}
			case 'osc': {
				if (byte === 0x07) this.finishOsc(1);
				else if (byte === 0x1b) this.mode = 'osc-escape';
				else if (byte >= 0x80) this.oversized = true;
				else this.append(byte);
				break;
			}
			case 'osc-escape': {
				if (byte === 0x5c) this.finishOsc(2);
				else {
					this.mode = 'escape';
					this.consume(byte);
				}
				break;
			}
			case 'string': {
				if (byte === 0x1b) this.mode = 'string-escape';
				else this.append(byte);
				break;
			}
			case 'string-escape': {
				if (byte === 0x5c) {
					if (
						!this.oversized &&
						this.stringKind === 'dcs' &&
						Buffer.from(this.body.slice(0, 5)).toString() === 'tmux;'
					) {
						const inner = Uint8Array.from(this.body.slice(5));
						this.mode = 'text';
						this.body = [];
						this.feed(inner);
					}
					this.mode = 'text';
					this.body = [];
					this.oversized = false;
				} else if (
					byte === 0x1b &&
					this.stringKind === 'dcs' &&
					Buffer.from(this.body.slice(0, 5)).toString() === 'tmux;'
				) {
					this.append(0x1b);
					this.mode = 'string';
				} else {
					this.append(0x1b);
					this.append(byte);
					this.mode = 'string';
				}
				break;
			}
		}
	}
}
