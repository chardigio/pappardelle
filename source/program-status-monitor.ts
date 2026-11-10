import {bunIsolationArgs, isStandalone} from './runtime.ts';
import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
	existsSync,
	appendFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, promisify} from 'node:util';
import {
	ProgramStatusStore,
	TerminalStatusParser,
	parseProgramReport,
	type ProgramReport,
	type ProgramStatusInfo,
} from './program-status.ts';
import {createLogger} from './logger.ts';

const execute = promisify(execFile);
const log = createLogger('program-status');
export const STATUS_MONITOR_OPTION = '@pappardelle_status_generation';
export const STATUS_PANE_OPTION = '@pappardelle_status_pane';
export type StatusTmuxRunner = (args: string[]) => Promise<string>;
export const runStatusTmux: StatusTmuxRunner = async args => {
	const result = await execute('tmux', args, {
		timeout: 5000,
		maxBuffer: 1024 * 1024,
	});
	return result.stdout;
};

export function statusSocket(env: NodeJS.ProcessEnv = process.env): string {
	return env['PAPPARDELLE_TMUX_SOCKET'] ?? 'pappardelle_inner';
}
export function statusTmuxArgs(
	args: string[],
	socket = statusSocket(),
): string[] {
	return socket.startsWith('/')
		? ['-S', socket, ...args]
		: ['-L', socket, ...args];
}
export function shellQuoteStatus(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function segment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}
export function programStatusDir(repo: string): string {
	return path.join(
		process.env['PAPPARDELLE_PROGRAM_STATUS_DIR'] ??
			path.join(homedir(), '.pappardelle', 'program-status'),
		segment(repo),
	);
}
export function programStatusPath(
	repo: string,
	key: string,
	generation: string,
): string {
	return path.join(
		programStatusDir(repo),
		`${segment(key)}--${generation}.json`,
	);
}
export function statusKeyFromFilename(filename: string): string | undefined {
	const match = /^(.*)--[a-f\d]{32}\.json$/.exec(filename);
	try {
		return match ? decodeURIComponent(match[1]!) : undefined;
	} catch {
		return undefined;
	}
}

export interface StatusPane {
	id: string;
	pid: string;
	dead: boolean;
	piped: boolean;
	marker: string;
	generation: string;
}
export function parseStatusPane(
	output: string,
	socket: string,
): StatusPane | null {
	const [id, pid, dead, piped, marker = ''] =
		output.trim().split('\n')[0]?.split('\t') ?? [];
	if (!id || !/^%\d+$/.test(id) || !pid || !/^\d+$/.test(pid)) return null;
	return {
		id,
		pid,
		dead: dead === '1',
		piped: piped === '1',
		marker,
		generation: createHash('sha256')
			.update(`${socket}:${id}:${pid}:${marker}`)
			.digest('hex')
			.slice(0, 32),
	};
}

export const STATUS_PANE_FORMAT = `#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_pipe}\t#{${STATUS_MONITOR_OPTION}}`;

export interface ProgramStatusSnapshot {
	version: 1;
	repo: string;
	key: string;
	pane: StatusPane;
	authoritative: boolean;
	exited: boolean;
	updatedAt: number;
	records: ProgramReport[];
	info: ProgramStatusInfo;
}

export function readProgramSnapshot(
	repo: string,
	key: string,
	pane: StatusPane,
): ProgramStatusSnapshot | null {
	try {
		const value: ProgramStatusSnapshot = JSON.parse(
			readFileSync(programStatusPath(repo, key, pane.generation), 'utf8'),
		);
		if (
			value.version !== 1 ||
			value.repo !== repo ||
			value.key !== key ||
			value.pane?.generation !== pane.generation ||
			value.pane.id !== pane.id ||
			value.pane.pid !== pane.pid ||
			typeof value.authoritative !== 'boolean' ||
			!Array.isArray(value.records) ||
			value.records.length > 256 ||
			typeof value.exited !== 'boolean' ||
			!Number.isFinite(value.updatedAt)
		)
			return null;
		const store = new ProgramStatusStore();
		for (const report of value.records) {
			if (!report || typeof report.id !== 'string' || report.state === 'clear')
				return null;
			const fields = [`state=${report.state}`];
			if (report.id) fields.push(`id=${report.id}`);
			for (const name of ['app', 'kind', 'progress'] as const) {
				if (report[name] !== undefined) fields.push(`${name}=${report[name]}`);
			}
			for (const [name, wire] of [
				['message', 'msg'],
				['title', 'title'],
			] as const) {
				if (report[name] !== undefined) {
					if (typeof report[name] !== 'string') return null;
					fields.push(
						`${wire}=${Buffer.from(report[name]!).toString('base64')}`,
					);
				}
			}
			const parsed = parseProgramReport(fields.join(':'));
			if (!isDeepStrictEqual(parsed, report)) return null;
			store.apply(report);
		}
		if (!isDeepStrictEqual(value.info, store.status())) return null;
		if (pane.dead || value.exited) store.processExit();
		value.info = store.status();
		return value;
	} catch {
		return null;
	}
}

function monitorEntry(): string[] {
	if (isStandalone) return [process.execPath, '--internal-status-monitor'];
	const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
	const entry = fileURLToPath(
		new URL(`program-status-monitor-cli${extension}`, import.meta.url),
	);
	return [process.execPath, ...bunIsolationArgs, entry];
}

export async function attachStatusMonitor(
	repo: string,
	key: string,
	session: string,
	socket = statusSocket(),
	run: StatusTmuxRunner = runStatusTmux,
): Promise<StatusPane | null> {
	try {
		const target = `=${session}:`;
		// The pinned pane and the session's current pane in one call. They are
		// the same pane unless the session has grown a second one.
		const located = await run(
			statusTmuxArgs(
				[
					'display-message',
					'-p',
					'-t',
					target,
					`#{${STATUS_PANE_OPTION}}\t${STATUS_PANE_FORMAT}`,
				],
				socket,
			),
		);
		const [pinned = '', ...current] = (located.split('\n')[0] ?? '').split(
			'\t',
		);
		let pane = parseStatusPane(current.join('\t'), socket);
		if (pinned && pinned !== pane?.id)
			pane = parseStatusPane(
				await run(
					statusTmuxArgs(
						['display-message', '-p', '-t', pinned, STATUS_PANE_FORMAT],
						socket,
					),
				),
				socket,
			);
		if (!pane) return null;
		const pin = pinned
			? []
			: ['set-option', '-t', target, STATUS_PANE_OPTION, pane.id];
		if (pin.length > 0 && (pane.dead || pane.piped))
			await run(statusTmuxArgs(pin, socket));
		if (pane.dead) return pane;
		if (pane.piped) {
			if (!pane.marker.startsWith(`${pane.pid}.`))
				log.debug(
					`Status monitoring skipped for ${session}: pane already has a pipe`,
				);
			return pane;
		}
		const marker = `${pane.pid}.${randomUUID()}`;
		pane = parseStatusPane(`${pane.id}\t${pane.pid}\t0\t0\t${marker}`, socket)!;
		const dir = programStatusDir(repo);
		mkdirSync(dir, {recursive: true});
		const lease = `${programStatusPath(repo, key, pane.generation)}.lease`;
		writeFileSync(lease, '');
		const command = [
			...monitorEntry(),
			'watch',
			repo,
			key,
			socket,
			Buffer.from(JSON.stringify(pane)).toString('base64'),
			dir,
			process.env['PAPPARDELLE_PROGRAM_STATUS_TRACE_DIR'] ?? '',
		]
			.map(value => shellQuoteStatus(value))
			.join(' ');
		const commands = [
			['set-option', '-p', '-t', pane.id, STATUS_MONITOR_OPTION, marker],
			[
				'pipe-pane',
				'-Oo',
				'-t',
				pane.id,
				command.replaceAll('%', '%%').replaceAll('#', '##'),
			],
		]
			.map(args => args.map(value => shellQuoteStatus(value)).join(' '))
			.join(' ; ');
		// The tmux command queue keeps the marker and pipe owned by the same
		// attachment, and the read that follows sees what it left.
		const attached = parseStatusPane(
			await run(
				statusTmuxArgs(
					[
						...pin,
						...(pin.length > 0 ? [';'] : []),
						'if-shell',
						'-F',
						'-t',
						pane.id,
						'#{pane_pipe}',
						'',
						commands,
						';',
						'display-message',
						'-p',
						'-t',
						pane.id,
						STATUS_PANE_FORMAT,
					],
					socket,
				),
			),
			socket,
		);
		if (attached?.generation === pane.generation) {
			// A session has one status pane, so earlier generations' files belong
			// to panes that no longer exist.
			removeProgramSnapshots(repo, key, pane.generation);
		} else {
			rmSync(lease, {force: true});
		}

		return attached;
	} catch (error) {
		log.debug(`Cannot monitor ${session}: ${String(error)}`);
		return null;
	}
}

export function removeProgramSnapshots(
	repo: string,
	key: string,
	keepGeneration?: string,
): void {
	try {
		const kept =
			keepGeneration === undefined
				? undefined
				: path.basename(programStatusPath(repo, key, keepGeneration));
		const files = readdirSync(programStatusDir(repo)).filter(
			file =>
				statusKeyFromFilename(file.replace(/\.lease$|\.tmp\.\d+$/g, '')) ===
					key &&
				(kept === undefined || !file.startsWith(kept)),
		);
		for (const file of files.filter(file => file.endsWith('.lease')))
			rmSync(path.join(programStatusDir(repo), file), {force: true});
		for (const file of files.filter(file => !file.endsWith('.lease')))
			rmSync(path.join(programStatusDir(repo), file), {force: true});
	} catch {}
}

export function monitorPane(
	repo: string,
	key: string,
	socket: string,
	pane: StatusPane,
	dir: string,
	traceDir?: string,
): void {
	const store = new ProgramStatusStore();
	const target = path.join(dir, `${segment(key)}--${pane.generation}.json`);
	const temp = `${target}.tmp.${process.pid}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let exited = false;
	let stopped = false;
	let traceBytes = 0;
	const publish = () => {
		timer = undefined;
		if (!existsSync(`${target}.lease`)) return;
		const snapshot: ProgramStatusSnapshot = {
			version: 1,
			repo,
			key,
			pane,
			authoritative: store.authoritative,
			exited,
			updatedAt: Date.now(),
			records: store.records(),
			info: store.status(),
		};
		try {
			writeFileSync(temp, JSON.stringify(snapshot));
			renameSync(temp, target);
			if (!existsSync(`${target}.lease`)) rmSync(target, {force: true});
		} catch {
			try {
				rmSync(temp, {force: true});
			} catch {}
		}
	};
	const schedule = () => {
		timer ??= setTimeout(publish, 50);
	};
	const parser = new TerminalStatusParser(event => {
		if (traceDir) {
			try {
				mkdirSync(traceDir, {recursive: true});
				const trace = path.join(
					traceDir,
					`${segment(key)}--${pane.generation}.jsonl`,
				);
				const line = `${JSON.stringify({at: Date.now(), ...event})}\n`;
				traceBytes += Buffer.byteLength(line);
				if (traceBytes <= 1024 * 1024) appendFileSync(trace, line);
			} catch {}
		}
		if (event.type === 'query') return;
		if (event.type === 'report') store.apply(event.report);
		else if (event.type === 'prompt') store.processExit();
		else store.reset();
		schedule();
	});
	const stop = () => {
		if (stopped) return;
		stopped = true;
		exited = true;
		clearTimeout(timer);
		clearInterval(liveness);
		store.processExit();
		publish();
		process.stdin.destroy();
	};
	// A closed socket may not deliver EOF on every tmux version.
	const liveness = setInterval(() => {
		void runStatusTmux(
			statusTmuxArgs(
				['display-message', '-p', '-t', pane.id, '#{pane_pid} #{pane_dead}'],
				socket,
			),
		)
			.then(value => {
				if (value.trim() !== `${pane.pid} 0`) stop();
			})
			.catch((error: unknown) => {
				log.debug(`Cannot check pane ${pane.id}: ${String(error)}`);
				try {
					process.kill(Number(pane.pid), 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop();
				}
			});
	}, 5000);
	process.stdin.on('data', (bytes: Buffer) => parser.feed(bytes));
	process.stdin.on('end', stop);
	process.stdin.on('error', stop);
	process.once('SIGTERM', stop);
	process.once('SIGHUP', stop);
	if (!existsSync(target)) publish();
}
