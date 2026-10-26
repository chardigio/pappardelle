import type {ClaudeSessionState} from './types.ts';
import {sendKeysLiteralThenEnter, type OuterTmuxRunner} from './tmux.ts';

export type ReloadDeps = {
	innerTmux: OuterTmuxRunner;
	readStatuses: () => ClaudeSessionState[];
	vimMode: boolean;
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

/* eslint-disable no-control-regex */
const sgr = /\u001B\[[\d;]*m/g;
const leadingSgr = /^(?:\u001B\[[\d;]*m)*/;
/* eslint-enable no-control-regex */
const ruleLine = /^─{10,}$/;

// The keys go through the input box as typed: C-u clears only the line under
// the cursor, so any draft text would be submitted with the command, and in
// vim normal mode the letters run as motions. Matches the box Claude Code
// draws: a `❯` line between two rules, where an empty input shows nothing or
// the dimmed placeholder.
export function inputBoxIsEmpty(screen: string, vimMode: boolean): boolean {
	const lines = screen.split('\n');
	const plain = lines.map(line => line.replaceAll(sgr, '').trim());
	if (vimMode && !plain.some(line => line.includes('-- INSERT --'))) {
		return false;
	}

	for (let i = plain.length - 2; i > 0; i--) {
		if (!plain[i]!.startsWith('❯')) continue;
		if (!ruleLine.test(plain[i - 1]!) || !ruleLine.test(plain[i + 1]!)) {
			continue;
		}

		const raw = lines[i]!;
		const afterPrompt = raw
			.slice(raw.indexOf('❯') + 1)
			.replace(/^[\u00A0 ]/, '');
		const leading = leadingSgr.exec(afterPrompt)![0];
		const text = afterPrompt.slice(leading.length).replaceAll(sgr, '').trim();
		return text === '' || leading.endsWith('\u001B[2m');
	}

	return false;
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
		const target = `=${session}:`;
		const sent =
			acceptsTypedInput(state) &&
			inputBoxIsEmpty(capture(deps.innerTmux, target), deps.vimMode) &&
			sendKeysLiteralThenEnter(deps.innerTmux, target, '/reload-plugins');
		(sent ? result.reloaded : result.skipped).push(name);
	}

	return result;
}

function capture(innerTmux: OuterTmuxRunner, target: string): string {
	const result = innerTmux(['capture-pane', '-p', '-e', '-t', target]);
	return result.error || result.status !== 0 ? '' : result.stdout;
}
