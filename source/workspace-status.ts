import {isDeepStrictEqual} from 'node:util';
import {
	mapClaudeStatus,
	type ClaudeStatusDao,
	type ClaudeStatusInfo,
} from './claude-status.ts';
import {
	statusSocket,
	type ProgramStatusDao,
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
		private readonly programStatus: ProgramStatusDao,
		private readonly sessionName: (key: string) => string,
		private readonly claudeStatus: Pick<ClaudeStatusDao, 'read' | 'watch'>,
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
			pane: this.programStatus.attach(sessionKey, session, socket, this.run),
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
		const snapshot = pane ? this.programStatus.read(sessionKey, pane) : null;
		if (
			!pane ||
			!snapshot ||
			snapshot.exited ||
			!this.programStatus.monitored(sessionKey, pane.generation)
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
			await this.claudeStatus.read(key),
			pane ? this.programStatus.read(sessionKey, pane) : null,
			pane,
		);
	}

	watch(
		callback: (updates: ReadonlyMap<string, ProgramStatusInfo>) => void,
		relevant: (key: string) => boolean,
	): () => void {
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
			}, 10);
		};
		const queue = (key: string | undefined) => {
			if (key && relevant(key)) {
				pending.add(key);
				schedule();
			}
		};
		const stopHookWatch = this.claudeStatus.watch(queue);
		const stopSnapshotWatch = this.programStatus.watch(snapshotKey => {
			for (const [key, sessionKey] of this.sessionKeys)
				if (sessionKey === snapshotKey) queue(key);
		});
		return () => {
			stopped = true;
			clearTimeout(timer);
			pending.clear();
			stopHookWatch();
			stopSnapshotWatch();
		};
	}
}
