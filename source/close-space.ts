// The hook half of closing a space, shared by the TUI's `x`/`K`/auto-remove
// path and `pappardelle close`, so both run the same pre_workspace_deinit
// hooks for the same space.

import {
	getMainRepoRoot,
	getRepoName,
	getRepoRoot,
	matchProfileByProject,
	matchProfiles,
	readConfig,
	type CommandConfig,
	type ConfigLoad,
	type PappardelleConfig,
} from './config.ts';
import type {TrackerIssue} from './providers/types.ts';
import {
	runPreWorkspaceDeinit,
	type DeinitContext,
	type DeinitResult,
} from './workspace-deinit.ts';

export function resolveDeinitCommands(
	config: PappardelleConfig,
	trackerIssue: TrackerIssue | null | undefined,
): CommandConfig[] {
	const commands: CommandConfig[] = [...(config.pre_workspace_deinit ?? [])];

	let matched: {profile: {pre_workspace_deinit?: CommandConfig[]}} | undefined;
	if (trackerIssue?.project?.name) {
		matched =
			matchProfileByProject(
				config,
				trackerIssue.project.name,
				trackerIssue.project.key,
			) ?? undefined;
	}

	if (!matched && trackerIssue?.title) {
		matched = matchProfiles(config, trackerIssue.title)[0];
	}

	commands.push(...(matched?.profile.pre_workspace_deinit ?? []));
	return commands;
}

/**
 * `pappardelle close` unregisters a space from outside the TUI, whose row stays
 * up until the next refresh. Attaching to that row would recreate the sessions
 * the close just ended. An unreadable registry (null) attaches anyway, so a
 * read failure can't blank the viewer panes.
 */
export function shouldAttach(
	space: {name: string; isMainWorktree?: boolean; isPending?: boolean},
	registered: readonly string[] | null,
): boolean {
	if (space.isMainWorktree || space.isPending || registered === null) {
		return true;
	}

	return registered.includes(space.name);
}

export type ClosingSpace = {
	name: string;
	worktreePath: string | null;
	trackerIssue: TrackerIssue | null | undefined;
};

export type CloseHooksDeps = {
	readConfig: () => ConfigLoad;
	runDeinit: (
		commands: CommandConfig[],
		worktreePath: string,
		context: DeinitContext,
	) => Promise<DeinitResult>;
	context: () => Omit<DeinitContext, 'issueKey'>;
};

export const defaultCloseHooksDeps: CloseHooksDeps = {
	readConfig: () => readConfig(),
	runDeinit: runPreWorkspaceDeinit,
	context: () => ({
		repoRoot: getRepoRoot(),
		mainRepoRoot: getMainRepoRoot(),
		repoName: getRepoName(),
	}),
};

export type CloseHooksOutcome =
	| {kind: 'ran'}
	| {kind: 'failed'; failedCommand?: string}
	| {kind: 'config-invalid'; errors: string[]};

export function closedWithoutDeinit(key: string): string {
	return `Closed ${key} without its deinit commands: the config is invalid`;
}

/**
 * An invalid config can't say which deinit commands a space has, and must not
 * leave the space impossible to close, so the caller closes it and says so.
 */
export async function runCloseHooks(
	space: ClosingSpace,
	deps: CloseHooksDeps = defaultCloseHooksDeps,
): Promise<CloseHooksOutcome> {
	const load = deps.readConfig();
	if (load.kind === 'invalid')
		return {kind: 'config-invalid', errors: load.errors};
	if (load.kind === 'missing' || !space.worktreePath) return {kind: 'ran'};
	const commands = resolveDeinitCommands(load.config, space.trackerIssue);
	if (commands.length === 0) return {kind: 'ran'};
	const result = await deps.runDeinit(commands, space.worktreePath, {
		issueKey: space.name,
		...deps.context(),
	});
	return result.success
		? {kind: 'ran'}
		: {kind: 'failed', failedCommand: result.failedCommand};
}
