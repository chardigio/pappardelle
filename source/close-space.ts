// The hook half of closing a space, shared by the TUI's `d`/`K`/auto-remove
// path and `pappardelle close`, so both run the same pre_workspace_deinit
// hooks for the same space.

import {
	getMainRepoRoot,
	getRepoName,
	getRepoRoot,
	loadConfig,
	matchProfileByProject,
	matchProfiles,
	type CommandConfig,
	type PappardelleConfig,
} from './config.ts';
import {createLogger} from './logger.ts';
import type {TrackerIssue} from './providers/types.ts';
import {
	runPreWorkspaceDeinit,
	type DeinitContext,
	type DeinitResult,
} from './workspace-deinit.ts';

const log = createLogger('close-space');

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

export type CloseHooksDeps = {
	loadConfig: () => PappardelleConfig;
	runDeinit: (
		commands: CommandConfig[],
		worktreePath: string,
		context: DeinitContext,
	) => Promise<DeinitResult>;
	context: () => Omit<DeinitContext, 'issueKey'>;
};

export const defaultCloseHooksDeps: CloseHooksDeps = {
	loadConfig,
	runDeinit: runPreWorkspaceDeinit,
	context: () => ({
		repoRoot: getRepoRoot(),
		mainRepoRoot: getMainRepoRoot(),
		repoName: getRepoName(),
	}),
};

export async function runCloseHooks(
	space: {
		name: string;
		worktreePath: string | null;
		trackerIssue: TrackerIssue | null | undefined;
	},
	deps: CloseHooksDeps = defaultCloseHooksDeps,
): Promise<DeinitResult> {
	try {
		const commands = resolveDeinitCommands(
			deps.loadConfig(),
			space.trackerIssue,
		);
		if (commands.length === 0 || !space.worktreePath) return {success: true};
		return await deps.runDeinit(commands, space.worktreePath, {
			issueKey: space.name,
			...deps.context(),
		});
	} catch (err) {
		// A broken config must not leave a space impossible to close.
		log.error(
			'pre_workspace_deinit error',
			err instanceof Error ? err : undefined,
		);
		return {success: true};
	}
}
