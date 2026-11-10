import {randomUUID} from 'node:crypto';
import {createLogger} from './logger.ts';

type Stage =
	| 'unattributed-bootstrap'
	| 'configuration'
	| 'repo-bootstrap'
	| 'outer-bootstrap'
	| 'outer-cleanup'
	| 'legacy-migration'
	| 'inner-reaping'
	| 'layout-setup'
	| 'setup-geometry'
	| 'setup-panes'
	| 'setup-chrome'
	| 'setup-sync-output'
	| 'commit-metadata'
	| 'version-metadata'
	| 'renderer'
	| 'renderer-imports'
	| 'main-discovery'
	| 'attachment-queue'
	| 'attachment'
	| 'agent-session'
	| 'companion-session'
	| 'monitor-ready'
	| 'viewer-attachment'
	| 'layout-request'
	| 'layout-queue'
	| 'layout-pass'
	| 'attachment-ready'
	| 'finished';

type Outcome =
	| 'ok'
	| 'failed'
	| 'cancelled'
	| 'unavailable'
	| 'incomplete'
	| 'delegated';
export type LayoutTraceInputs = {
	cause?: 'state' | 'resize';
	loading?: boolean;
	spaces?: number;
	zoomed?: boolean;
	revision?: number;
	cols?: number;
	rows?: number;
};

export type StartupRecord = {
	launchId: string;
	parentLaunchId?: string;
	pid: number;
	id: number;
	stage: Stage;
	phase: 'begin' | 'end';
	elapsedMs: number;
	durationMs?: number;
	outcome?: Outcome;
	pending?: number;
	inputs?: LayoutTraceInputs;
};

type Schedule = (callback: () => void, ms: number) => () => void;
const schedule: Schedule = (callback, ms) => {
	const timer = setTimeout(callback, ms);
	timer.unref();
	return () => clearTimeout(timer);
};

/** Startup-only records; no commands, paths, prompts or environment payloads. */
export class StartupTrace {
	readonly launchId = randomUUID();
	private nextId = 0;
	private records = 0;
	private readonly active = new Set<number>();
	private attached = false;
	private stopped = false;
	private cancelObservation?: () => void;
	private readonly cancelDeadline: () => void;

	constructor(
		private readonly deps: {
			now: () => number;
			write: (record: StartupRecord) => void;
			pid: number;
			parentLaunchId?: string;
			schedule?: Schedule;
		},
	) {
		this.cancelDeadline = (deps.schedule ?? schedule)(
			() => this.finish('incomplete'),
			30_000,
		);
		this.emit({
			id: this.nextId++,
			stage: 'unattributed-bootstrap',
			phase: 'end',
			durationMs: deps.now(),
			outcome: 'ok',
		});
	}

	begin(
		stage: Stage,
		inputs?: LayoutTraceInputs,
	): ((outcome?: Outcome) => void) | undefined {
		if (this.stopped) return undefined;
		if (this.records >= 510) {
			this.finish('incomplete');
			return undefined;
		}
		this.cancelObservation?.();
		const id = this.nextId++;
		const start = this.deps.now();
		this.active.add(id);
		this.emit({id, stage, phase: 'begin', inputs});
		return (outcome = 'ok') => {
			if (!this.active.delete(id) || this.stopped) return;
			this.emit({
				id,
				stage,
				phase: 'end',
				durationMs: this.deps.now() - start,
				outcome,
			});
			this.observe();
		};
	}

	attachmentReady(): void {
		if (this.attached || this.stopped) return;
		this.attached = true;
		this.emit({
			id: this.nextId++,
			stage: 'attachment-ready',
			phase: 'end',
			outcome: 'ok',
		});
		this.observe();
	}

	finish(outcome: 'ok' | 'incomplete' | 'delegated' = 'incomplete'): void {
		if (this.stopped) return;
		this.stopped = true;
		this.cancelDeadline();
		this.cancelObservation?.();
		this.emit({
			id: this.nextId++,
			stage: 'finished',
			phase: 'end',
			outcome,
			pending: this.active.size,
		});
		this.active.clear();
	}

	private observe(): void {
		if (!this.attached || this.active.size > 0 || this.stopped) return;
		this.cancelObservation?.();
		this.cancelObservation = (this.deps.schedule ?? schedule)(
			() => this.finish('ok'),
			300,
		);
	}

	private emit(
		record: Omit<
			StartupRecord,
			'launchId' | 'parentLaunchId' | 'pid' | 'elapsedMs'
		>,
	): void {
		if (record.stage !== 'finished' && this.records >= 511) {
			this.finish('incomplete');
			return;
		}
		if (this.records++ >= 512) return;
		this.deps.write({
			...record,
			launchId: this.launchId,
			parentLaunchId: this.deps.parentLaunchId,
			pid: this.deps.pid,
			elapsedMs: this.deps.now(),
		});
	}
}

const enabled = process.env['PAPPARDELLE_STARTUP_TRACE'] === '1';
const parent = process.env['PAPPARDELLE_STARTUP_PARENT'];
const parentLaunchId =
	parent && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(parent)
		? parent
		: undefined;
export const startupTrace: {current?: StartupTrace} = {};

export function startStartupTrace(): void {
	if (!enabled || startupTrace.current) return;
	const log = createLogger('startup');
	startupTrace.current = new StartupTrace({
		now: () => process.uptime() * 1000,
		pid: process.pid,
		parentLaunchId,
		write: record => log.debug(JSON.stringify(record)),
	});
	process.once('exit', () => startupTrace.current?.finish());
}

/** Session environment survives restart without freezing the child's launch ID. */
export function startupSessionEnvArgs(): string[] {
	return startupTrace.current
		? [
				'-e',
				'PAPPARDELLE_STARTUP_TRACE=1',
				'-e',
				`PAPPARDELLE_STARTUP_PARENT=${startupTrace.current.launchId}`,
			]
		: [];
}
