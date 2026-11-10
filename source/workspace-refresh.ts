import type {ProgramStatusInfo} from './program-status.ts';
import {isDeepStrictEqual} from 'node:util';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {applyStatusUpdates} from './workspace-status.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {pLimit} from './providers/concurrency.ts';
import type {SpaceData, TrackerIssue} from './types.ts';

class RefreshLoop {
	private pending = false;
	private running?: Promise<void>;

	constructor(private readonly task: () => Promise<void>) {}

	async request(): Promise<void> {
		this.pending = true;
		this.running ??= Promise.resolve().then(async () => {
			try {
				do {
					this.pending = false;
					await this.task();
				} while (this.pending);
			} finally {
				this.running = undefined;
			}
		});
		return this.running;
	}

	async idle(): Promise<void> {
		await this.running;
	}
}

type MainWorktree = {path: string; branch: string};

export interface WorkspaceRefreshDeps {
	detailReady?: Promise<void>;
	readRegistry: () => Promise<string[] | null>;
	readStatus: (
		statusKey: string,
		sessionKey: string,
	) => Promise<ProgramStatusInfo | null>;
	readWorktreePath: (key: string) => Promise<string | null>;
	readMainWorktree: () => Promise<MainWorktree | null>;
	readDirty: (path: string) => Promise<boolean | null>;
	/** Hook status key of a space key, or of the main checkout's branch. */
	statusKey: (name: string) => string;
	getCachedIssue: (key: string) => TrackerIssue | null;
	fetchIssues: (keys: string[]) => Promise<unknown>;
	readEmoji: (
		key: string | undefined,
		issue: TrackerIssue | null,
	) => Promise<string | undefined>;
	setSpaces: (update: (spaces: SpaceData[]) => SpaceData[]) => void;
	onLoaded: () => void;
	onError: (error: unknown) => void;
}

function patchSpace(space: SpaceData, patch: Partial<SpaceData>): SpaceData {
	return Object.entries(patch).every(([key, value]) =>
		key === 'programStatus'
			? isDeepStrictEqual(space.programStatus, value)
			: Object.is(space[key as keyof SpaceData], value),
	)
		? space
		: {...space, ...patch};
}

function reuseArray(previous: SpaceData[], next: SpaceData[]): SpaceData[] {
	return previous.length === next.length &&
		next.every((space, index) => space === previous[index])
		? previous
		: next;
}

/**
 * Rail order: newest first by issue number, whatever the team prefix (ABC-50
 * above STA-12). Beads hash keys have no order of their own, but must keep one
 * place across refreshes.
 */
export function compareSpaceNames(a: string, b: string): number {
	const numberA = issueNumber(a);
	const numberB = issueNumber(b);
	if (numberA !== undefined && numberB !== undefined && numberA !== numberB)
		return numberB - numberA;
	return b.localeCompare(a, 'en', {numeric: true});
}

function issueNumber(name: string): number | undefined {
	const match = /-(\d+)$/.exec(name);
	return match ? Number(match[1]) : undefined;
}

/** Polling repairs missed hook events without replacing newer hook or rail state. */
export class WorkspaceRefresh {
	private stopped = false;
	private listGeneration = 0;
	private names: string[] = [];
	private readonly statusVersions = new Map<string, number>();
	private readonly list: RefreshLoop;
	private readonly main: RefreshLoop;
	private readonly issues: RefreshLoop;

	constructor(private readonly deps: WorkspaceRefreshDeps) {
		this.list = new RefreshLoop(async () => {
			try {
				await this.refreshList();
			} catch (err) {
				this.report(err);
			} finally {
				if (!this.stopped) deps.onLoaded();
			}
		});
		this.main = new RefreshLoop(async () => {
			try {
				await this.refreshMain();
			} catch (err) {
				this.report(err);
			}
		});
		this.issues = new RefreshLoop(async () => {
			try {
				await this.refreshIssues();
			} catch (err) {
				this.report(err);
			}
		});
	}

	async refresh(): Promise<void> {
		if (this.stopped) return;
		void this.main.request();
		await this.refreshListOnly();
	}

	/** Invalidate a snapshot taken before a local registry mutation. */
	async refreshListOnly(): Promise<void> {
		if (this.stopped) return;
		this.listGeneration++;
		await this.list.request();
	}

	applyStatusUpdates(updates: ReadonlyMap<string, ProgramStatusInfo>): void {
		if (this.stopped) return;
		for (const key of updates.keys()) {
			this.statusVersions.set(key, (this.statusVersions.get(key) ?? 0) + 1);
		}
		this.publish(spaces => applyStatusUpdates(spaces, updates));
	}

	stop(): void {
		this.stopped = true;
	}

	async idle(): Promise<void> {
		await this.list.idle();
		await Promise.all([this.main.idle(), this.issues.idle()]);
	}

	private report(err: unknown): void {
		if (!this.stopped) this.deps.onError(err);
	}

	private publish(update: (spaces: SpaceData[]) => SpaceData[]): void {
		if (!this.stopped)
			this.deps.setSpaces(spaces => (this.stopped ? spaces : update(spaces)));
	}

	private async refreshList(): Promise<void> {
		if (this.stopped) return;
		const generation = this.listGeneration;
		const names = await this.deps.readRegistry();
		if (this.stopped || generation !== this.listGeneration || !names) return;
		this.names = [...new Set(names)]
			.filter(name => name !== MAIN_WORKTREE_KEY)
			.sort(compareSpaceNames);
		const orderedNames = this.names;
		this.publish(previous => {
			if (generation !== this.listGeneration) return previous;
			const byName = new Map(previous.map(space => [space.name, space]));
			const next = previous.filter(space => space.isMainWorktree);
			for (const name of orderedNames) {
				const existing = byName.get(name);
				next.push(
					existing && !existing.isPending
						? existing
						: {
								name,
								statusKey: this.deps.statusKey(name),
								worktreePath: null,
								programStatus: {status: 'unknown'},
								linearIssue: this.deps.getCachedIssue(name) ?? undefined,
							},
				);
			}
			next.push(
				...previous.filter(
					space => space.isPending && !orderedNames.includes(space.name),
				),
			);
			return reuseArray(previous, next);
		});
		void this.issues.request();
		if (!this.stopped) this.deps.onLoaded();
		if (this.deps.detailReady) await this.deps.detailReady;
		if (this.stopped || generation !== this.listGeneration) return;
		const details = await pLimit(
			orderedNames.map(key => async () => {
				if (this.stopped || generation !== this.listGeneration)
					return undefined;
				const statusKey = this.deps.statusKey(key);
				const version = this.statusVersions.get(statusKey) ?? 0;
				const [status, worktreePath] = await Promise.allSettled([
					this.deps.readStatus(statusKey, key),
					this.deps.readWorktreePath(key),
				]);
				await nextTurn();
				return {key, version, status, worktreePath};
			}),
			4,
		);
		const byName = new Map(
			details
				.filter(detail => detail !== undefined)
				.map(detail => [detail.key, detail]),
		);
		this.publish(previous => {
			if (generation !== this.listGeneration) return previous;
			return reuseArray(
				previous,
				previous.map(space => {
					const detail = byName.get(space.name);
					if (!detail || space.isPending || space.isMainWorktree) return space;
					const patch: Partial<SpaceData> = {};
					if (detail.worktreePath.status === 'fulfilled')
						patch.worktreePath = detail.worktreePath.value;
					if (
						detail.status.status === 'fulfilled' &&
						detail.status.value &&
						detail.version ===
							(this.statusVersions.get(this.deps.statusKey(space.name)) ?? 0)
					) {
						patch.programStatus = detail.status.value;
					}
					return patchSpace(space, patch);
				}),
			);
		});
	}

	private async refreshIssues(): Promise<void> {
		if (this.deps.detailReady) await this.deps.detailReady;
		if (this.stopped || this.names.length === 0) return;
		const {names} = this;
		await this.publishIssues(names);
		if (this.stopped) return;
		await this.deps.fetchIssues(names);
		await this.publishIssues(names);
	}

	private async publishIssues(names: string[]): Promise<void> {
		const results = await pLimit(
			names.map(key => async () => {
				if (this.stopped) return undefined;
				const issue = this.deps.getCachedIssue(key);
				const [emoji] = await Promise.allSettled([
					this.deps.readEmoji(key, issue),
				]);
				await nextTurn();
				return {key, issue, emoji};
			}),
			4,
		);
		const byName = new Map(
			results
				.filter(result => result !== undefined)
				.map(result => [result.key, result]),
		);
		this.publish(previous =>
			reuseArray(
				previous,
				previous.map(space => {
					const result = byName.get(space.name);
					if (!result || space.isPending || space.isMainWorktree) return space;
					const patch: Partial<SpaceData> = {};
					if (result.issue) {
						const current = space.trackerIssue ?? space.linearIssue;
						const issue = isDeepStrictEqual(current, result.issue)
							? current
							: result.issue;
						patch.linearIssue = issue;
						if (space.trackerIssue) patch.trackerIssue = issue;
					}
					if (result.emoji.status === 'fulfilled')
						patch.profileEmoji = result.emoji.value;
					return patchSpace(space, patch);
				}),
			),
		);
	}

	private async refreshMain(): Promise<void> {
		if (this.stopped) return;
		this.publish(previous =>
			previous.some(space => space.isMainWorktree)
				? previous
				: [
						{
							name: MAIN_WORKTREE_KEY,
							worktreePath: null,
							isMainWorktree: true,
							programStatus: {status: 'unknown'},
						},
						...previous,
					],
		);
		const info = await this.deps.readMainWorktree();
		if (!info || this.stopped) return;
		const statusKey = this.deps.statusKey(info.branch);
		this.publish(previous => {
			const current = previous.find(space => space.isMainWorktree);
			const base: SpaceData = current ?? {
				name: MAIN_WORKTREE_KEY,
				worktreePath: info.path,
				isMainWorktree: true,
				programStatus: {status: 'unknown'},
			};
			const main = patchSpace(base, {worktreePath: info.path, statusKey});
			return reuseArray(previous, [
				main,
				...previous.filter(space => !space.isMainWorktree),
			]);
		});
		const version = this.statusVersions.get(statusKey) ?? 0;
		const update = (patch: Partial<SpaceData>, guard = () => true) => {
			this.publish(previous =>
				reuseArray(
					previous,
					previous.map(space =>
						space.isMainWorktree &&
						space.worktreePath === info.path &&
						space.statusKey === statusKey &&
						guard()
							? patchSpace(space, patch)
							: space,
					),
				),
			);
		};
		await Promise.allSettled([
			this.deps.readStatus(statusKey, MAIN_WORKTREE_KEY).then(status => {
				if (status)
					update(
						{programStatus: status},
						() => version === (this.statusVersions.get(statusKey) ?? 0),
					);
			}),
			this.deps.readDirty(info.path).then(isDirty => {
				if (isDirty !== null) update({isDirty});
			}),
			this.deps.readEmoji(undefined, null).then(profileEmoji => {
				update({profileEmoji});
			}),
		]);
	}
}
