import test from 'ava';
import {inputBoxIsEmpty, reloadClaudeSessions} from './plugin-reload.ts';
import type {ClaudeSessionState} from './types.ts';
import type {OuterTmuxRunner} from './tmux.ts';

function state(
	workspaceName: string,
	cwd: string,
	status: ClaudeSessionState['status'],
	extra: Partial<ClaudeSessionState> = {},
): ClaudeSessionState {
	return {sessionId: 's', workspaceName, status, lastUpdate: 1, cwd, ...extra};
}

// Captured with `tmux capture-pane -p -e` from Claude Code 2.1.310.
const rule = '─'.repeat(40);
const insert =
	'\u001B[39m  \u001B[2m\u001B[37m-- INSERT --\u001B[0m auto mode on';
function screen(promptLine: string, footer = insert, extra: string[] = []) {
	return [
		`\u001B[37m${rule}`,
		promptLine,
		...extra,
		`\u001B[37m${rule}`,
		footer,
	].join('\n');
}

const idleEmpty = screen(
	'\u001B[39m❯\u00A0\u001B[2mTry "create a util logging.py that..."\u001B[0m',
);

function fakeTmux(sessions: string[], paneScreen = idleEmpty) {
	const sent: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: sessions.join('\n') + '\n', stderr: ''};
		}

		if (args[0] === 'capture-pane') {
			return {status: 0, stdout: paneScreen, stderr: ''};
		}

		if (args.includes('-l')) sent.push(`${args[2]} ${args.at(-1)}`);
		return {status: 0, stdout: '', stderr: ''};
	};

	return {runner, sent};
}

test('types /reload-plugins into idle and busy Claude sessions only', t => {
	const {runner, sent} = fakeTmux([
		'claude-app-STA-1\t/w/STA-1',
		'claude-app-STA-2\t/w/STA-2',
		'claude-app-STA-3\t/w/STA-3',
		'claude-app-STA-4\t/w/STA-4',
		'claude-app-STA-5\t/w/STA-5',
		'claude-app-STA-6\t/w/STA-6',
		'companion-app-STA-1\t/w/STA-1',
	]);
	const result = reloadClaudeSessions({
		innerTmux: runner,
		vimMode: true,
		readStatuses: () => [
			state('STA-1', '/w/STA-1', 'waiting_for_input'),
			state('STA-2', '/w/STA-2', 'running_tool', {currentTool: 'Bash'}),
			state('STA-3', '/w/STA-3', 'running_tool', {
				currentTool: 'AskUserQuestion',
			}),
			state('STA-4', '/w/STA-4', 'waiting_for_approval'),
			state('STA-5', '/w/STA-5', 'processing'),
		],
	});

	t.deepEqual(result, {
		reloaded: ['STA-1', 'STA-2', 'STA-5'],
		skipped: ['STA-3', 'STA-4', 'claude-app-STA-6'],
	});
	t.deepEqual(sent, [
		'=claude-app-STA-1: /reload-plugins',
		'=claude-app-STA-2: /reload-plugins',
		'=claude-app-STA-5: /reload-plugins',
	]);
});

test('uses the newest status when several share a directory', t => {
	const {runner, sent} = fakeTmux(['claude-app-main\t/repo']);
	const result = reloadClaudeSessions({
		innerTmux: runner,
		vimMode: true,
		readStatuses: () => [
			state('app-old-branch', '/repo', 'waiting_for_input', {lastUpdate: 1}),
			state('app-main', '/repo', 'waiting_for_approval', {lastUpdate: 2}),
		],
	});

	t.deepEqual(result, {reloaded: [], skipped: ['app-main']});
	t.deepEqual(sent, []);
});

test('does nothing without an inner tmux server', t => {
	const result = reloadClaudeSessions({
		innerTmux: () => ({status: 1, stdout: '', stderr: 'no server running'}),
		vimMode: false,
		readStatuses: () => [],
	});
	t.deepEqual(result, {reloaded: [], skipped: []});
});

test('types only into an input box that is empty and, in vim mode, inserting', t => {
	const busyEmpty = screen('\u001B[2m❯\u00A0\u001B[0m');
	t.true(inputBoxIsEmpty(idleEmpty, true));
	t.true(inputBoxIsEmpty(busyEmpty, true));
	t.true(inputBoxIsEmpty(screen('❯\u00A0', 'auto mode on'), false));

	t.false(inputBoxIsEmpty(screen('\u001B[39m❯\u00A0abc'), true));
	t.false(inputBoxIsEmpty(screen('\u001B[2m❯\u00A0\u001B[0mx'), true));
	t.false(
		inputBoxIsEmpty(screen('❯\u00A0first line', insert, ['  second']), true),
	);
	t.false(inputBoxIsEmpty(screen('❯\u00A0', 'auto mode on'), true));
	t.false(inputBoxIsEmpty('❯ 1. Yes\n  2. No', false));
});

test('leaves a session with a draft alone', t => {
	const {runner, sent} = fakeTmux(
		['claude-app-STA-1\t/w/STA-1'],
		screen('\u001B[39m❯\u00A0half a thought'),
	);
	const result = reloadClaudeSessions({
		innerTmux: runner,
		vimMode: true,
		readStatuses: () => [state('STA-1', '/w/STA-1', 'waiting_for_input')],
	});

	t.deepEqual(result, {reloaded: [], skipped: ['STA-1']});
	t.deepEqual(sent, []);
});
