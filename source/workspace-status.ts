import {mkdirSync, watch} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {
	getClaudeStatusInfoAsync,
	ensureStatusDir,
	getHookStatusDir,
	mapClaudeStatus,
} from './claude-status.ts';
import {
	attachStatusMonitor,
	programStatusDir,
	readProgramSnapshot,
	statusKeyFromFilename,
	statusSocket,
	type StatusTmuxRunner,
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

export class WorkspaceStatuses {
	private readonly sessionKeys = new Map<string, string>();
	constructor(
		private readonly repo: string,
		private readonly sessionName: (key: string) => string,
		private readonly run?: StatusTmuxRunner,
	) {}

	async read(key: string, sessionKey = key): Promise<ProgramStatusInfo | null> {
		this.sessionKeys.set(key, sessionKey);
		const [pane, hook] = await Promise.all([
			attachStatusMonitor(
				this.repo,
				sessionKey,
				this.sessionName(sessionKey),
				statusSocket(),
				this.run,
			),
			getClaudeStatusInfoAsync(key),
		]);
		const snapshot = pane
			? readProgramSnapshot(this.repo, sessionKey, pane)
			: null;
		if (snapshot?.authoritative) {
			const info: ProgramStatusInfo = {
				...snapshot.info,
				source: 'osc',
				generation: pane!.generation,
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
								const info = await this.read(
									key,
									this.sessionKeys.get(key) ?? key,
								);
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
