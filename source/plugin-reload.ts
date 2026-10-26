import type {ClaudeSessionState} from './types.ts';
import {sendKeysLiteralThenEnter, type OuterTmuxRunner} from './tmux.ts';

export type ReloadDeps = {
	innerTmux: OuterTmuxRunner;
	readStatuses: () => ClaudeSessionState[];
};

export type ReloadResult = {reloaded: string[]; skipped: string[]};

// Keystrokes typed into a question dialog or a permission prompt would answer
// it. Claude Code queues input typed while it works, so a busy session runs
// the reload when its turn ends.
const typeableStatuses = new Set<ClaudeSessionState['status']>([
	'waiting_for_input',
	'processing',
	'running_tool',
	'compacting',
]);

function acceptsTypedInput(state: ClaudeSessionState | undefined): boolean {
	return (
		state !== undefined &&
		typeableStatuses.has(state.status) &&
		state.currentTool !== 'AskUserQuestion'
	);
}

export function reloadClaudeSessions(deps: ReloadDeps): ReloadResult {
	const result: ReloadResult = {reloaded: [], skipped: []};
	const sessions = deps.innerTmux([
		'list-sessions',
		'-F',
		'#{session_name}\t#{session_path}',
	]);
	if (sessions.error || sessions.status !== 0) return result;

	// Hooks report the cwd Claude started in, which is the directory the
	// session was created in.
	const latestByCwd = new Map<string, ClaudeSessionState>();
	for (const state of deps.readStatuses()) {
		if (!state.cwd) continue;
		const seen = latestByCwd.get(state.cwd);
		if (!seen || state.lastUpdate > seen.lastUpdate) {
			latestByCwd.set(state.cwd, state);
		}
	}

	for (const line of sessions.stdout.split('\n')) {
		const [session, cwd] = line.split('\t');
		if (!session?.startsWith('claude-') || cwd === undefined) continue;
		const state = latestByCwd.get(cwd);
		const name = state?.workspaceName ?? session;
		const sent =
			acceptsTypedInput(state) &&
			sendKeysLiteralThenEnter(
				deps.innerTmux,
				`=${session}:`,
				'/reload-plugins',
			);
		(sent ? result.reloaded : result.skipped).push(name);
	}

	return result;
}
