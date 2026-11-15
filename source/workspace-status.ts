import {existsSync, mkdirSync, watch} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {
	getClaudeStatusInfoAsync,
	ensureStatusDir,
	getHookStatusDir,
	mapClaudeStatus,
	type ClaudeStatusInfo,
} from './claude-status.ts';
import {
	attachStatusMonitor,
	programStatusDir,
	programStatusPath,
	readProgramSnapshot,
	statusKeyFromFilename,
	statusSocket,
	type StatusTmuxRunner,
	type StatusPane,
	type ProgramStatusSnapshot,
} from './program-status-monitor.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import type {SpaceData} from './types.ts';

export function applyStatusUpdates(
	spaces: SpaceData[],
	updates: ReadonlyMap<string, ProgramStatusInfo>,
): SpaceData[] {
	let changed = false;
	const result = spaces.map(space => {
		const info = updates.get(space.statusKey ?? space.name);
		if (!info || isDeepStrictEqual(info, space.programStatus)) return space;
		changed = true;
		return {...space, programStatus: info};
	});
	return changed ? result : spaces;
}

/**
 * An agent's status from its hook file and its pane's status snapshot. Once
 * the agent has reported natively, the snapshot is the authority.
 */
export function mergeProgramStatus(
	hook: ClaudeStatusInfo | null,
	snapshot: ProgramStatusSnapshot | null,
	pane: StatusPane | null,
): ProgramStatusInfo | null {
	if (snapshot?.authoritative && pane) {
		const info: ProgramStatusInfo = {
			...snapshot.info,
			source: 'osc',
			generation: pane.generation,
		};
		const fallback = hook ? mapClaudeStatus(hook) : null;
		if (
			info.app === 'claude-code' &&
			!info.id &&
			info.status === 'working' &&
			fallback?.status === info.status
		) {
			if (fallback.tool) info.tool = fallback.tool;
			if (fallback.activity) info.activity = fallback.activity;
		}

		return info;
	}

	return hook ? mapClaudeStatus(hook) : null;
}

export class WorkspaceStatuses {
	private readonly sessionKeys = new Map<string, string>();
	private readonly panes = new Map<
		string,
		{
			socket: string;
			sessionKey: string;
			session: string;
			pane: Promise<StatusPane | null>;
		}
	>();

	constructor(
		private readonly repo: string,
		private readonly sessionName: (key: string) => string,
		private readonly run?: StatusTmuxRunner,
	) {}

	async read(key: string, sessionKey = key): Promise<ProgramStatusInfo | null> {
		this.sessionKeys.set(key, sessionKey);
		const socket = statusSocket();
		const session = this.sessionName(sessionKey);
		const entry = {
			socket,
			sessionKey,
			session,
			pane: attachStatusMonitor(
				this.repo,
				sessionKey,
				session,
				socket,
				this.run,
			),
		};
		this.panes.set(key, entry);
		return this.readPane(key, sessionKey, await entry.pane);
	}

	private async readKnown(key: string): Promise<ProgramStatusInfo | null> {
		const sessionKey = this.sessionKeys.get(key) ?? key;
		const entry = this.panes.get(key);
		if (
			!entry ||
			entry.socket !== statusSocket() ||
			entry.sessionKey !== sessionKey ||
			entry.session !== this.sessionName(sessionKey)
		)
			return this.read(key, sessionKey);
		const pane = await entry.pane;
		if (this.panes.get(key) !== entry) return this.readKnown(key);
		const snapshot = pane
			? readProgramSnapshot(this.repo, sessionKey, pane)
			: null;
		if (
			!pane ||
			!snapshot ||
			snapshot.exited ||
			!existsSync(
				`${programStatusPath(this.repo, sessionKey, pane.generation)}.lease`,
			)
		)
			return this.read(key, sessionKey);
		const info = await this.readPane(key, sessionKey, pane);
		return this.panes.get(key) === entry ? info : this.readKnown(key);
	}

	private async readPane(
		key: string,
		sessionKey: string,
		pane: StatusPane | null,
	): Promise<ProgramStatusInfo | null> {
		return mergeProgramStatus(
			await getClaudeStatusInfoAsync(key),
			pane ? readProgramSnapshot(this.repo, sessionKey, pane) : null,
			pane,
		);
	}

	watch(
		callback: (updates: ReadonlyMap<string, ProgramStatusInfo>) => void,
		relevant: (key: string) => boolean,
	): () => void {
		ensureStatusDir();
		mkdirSync(programStatusDir(this.repo), {recursive: true});
		const pending = new Set<string>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reading = false;
		let stopped = false;
		const schedule = () => {
			if (stopped || reading || timer || pending.size === 0) return;
			timer = setTimeout(async () => {
				timer = undefined;
				reading = true;
				const keys = [...pending];
				pending.clear();
				const updates = new Map<string, ProgramStatusInfo>();
				try {
					for (let offset = 0; offset < keys.length; offset += 4) {
						if (stopped) break;
						await Promise.all(
							keys.slice(offset, offset + 4).map(async key => {
								if (!relevant(key)) return;
								const info = await this.readKnown(key);
								if (info) updates.set(key, info);
							}),
						);
					}
					if (!stopped && updates.size) callback(updates);
				} finally {
					reading = false;
					schedule();
				}
			}, 50);
		};
		const queue = (key: string | undefined) => {
			if (key && relevant(key)) {
				pending.add(key);
				schedule();
			}
		};
		const hookWatcher = watch(getHookStatusDir(), (_event, filename) => {
			if (filename?.endsWith('.json')) queue(filename.slice(0, -5));
		});
		const oscWatcher = watch(
			programStatusDir(this.repo),
			(_event, filename) => {
				if (!filename) return;
				const snapshotKey = statusKeyFromFilename(filename);
				for (const [key, sessionKey] of this.sessionKeys)
					if (sessionKey === snapshotKey) queue(key);
			},
		);
		return () => {
			stopped = true;
			clearTimeout(timer);
			pending.clear();
			hookWatcher.close();
			oscWatcher.close();
		};
	}
}
