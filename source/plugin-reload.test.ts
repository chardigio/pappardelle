import test from 'ava';
import {reloadClaudeSessions} from './plugin-reload.ts';
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

function fakeTmux(sessions: string[]) {
	const sent: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions') {
			return {status: 0, stdout: sessions.join('\n') + '\n', stderr: ''};
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
		readStatuses: () => [],
	});
	t.deepEqual(result, {reloaded: [], skipped: []});
});
