import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'ava';
import {testSocketPath} from '../test/helpers/status-daemon.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import type {StoredClaudeStatus} from './claude-status.ts';
import {isPidAlive} from './file-lock.ts';
import {statusSocketPath} from './state-db.ts';
import {spawnStatusDaemon} from './status-client.ts';

const execute = promisify(execFile);
const daosModule = fileURLToPath(new URL('state-daos.ts', import.meta.url));
const hook = fileURLToPath(
	new URL('../plugins/pappardelle/hooks/update-status.py', import.meta.url),
);

// The whole path of a status change with the flag on, each part in its own
// process as in production: the Python hook, the daemon, and a reader.
test('a hook event sent to a running daemon reaches a watch in another process, and leaves no status file', async t => {
	const stateDir = path.dirname(testSocketPath(t));
	const socketPath = statusSocketPath(stateDir);
	// Nothing of the session these tests run in: its variables name the
	// developer's own space.
	const env = {
		PATH: process.env['PATH'],
		HOME: stateDir,
		PAPPARDELLE_SQLITE_STATE: '1',
		PAPPARDELLE_STATE_DB: path.join(stateDir, 'state.db'),
		PAPPARDELLE_STATUS_DIR: path.join(stateDir, 'claude-status'),
	};
	const daemon = spawnStatusDaemon(socketPath, env)!;
	t.teardown(() => {
		if (isPidAlive(daemon)) process.kill(daemon, 'SIGKILL');
	});
	await waitUntil(
		() => fs.existsSync(socketPath),
		'the daemon to listen',
		30_000,
	);

	const watcher = spawn(
		process.execPath,
		[
			'-e',
			`
			import {createStateDaos} from ${JSON.stringify(daosModule)};
			const {claudeStatus} = createStateDaos({
				repo: 'repo',
				stateDir: process.argv[1],
				sqlite: true,
			});
			claudeStatus.watch(async statusKey => {
				const stored = await claudeStatus.readState(statusKey);
				console.log(JSON.stringify({statusKey, stored}));
				process.exit(0);
			});
			await claudeStatus.readState('repo-STA-1');
			console.log('watching');
			setTimeout(() => process.exit(1), 30_000);
			`,
			stateDir,
		],
		{env, stdio: ['ignore', 'pipe', 'inherit']},
	);
	t.teardown(() => watcher.kill('SIGKILL'));
	let printed = '';
	watcher.stdout.setEncoding('utf8').on('data', (text: string) => {
		printed += text;
	});
	const watcherClosed = once(watcher, 'close');
	await waitUntil(
		() => printed.includes('watching\n'),
		'the watcher to hold the daemon state',
		30_000,
	);

	const reporting = execute('python3', [hook], {
		env: {...env, PAPPARDELLE_REPO: 'repo', PAPPARDELLE_SPACE: 'STA-1'},
	});
	reporting.child.stdin!.end(
		JSON.stringify({
			hook_event_name: 'PreToolUse',
			tool_name: 'Bash',
			session_id: 'session-1',
			cwd: '/work/STA-1',
		}),
	);
	await reporting;

	await watcherClosed;
	const seen = JSON.parse(printed.split('\n')[1]!) as {
		statusKey: string;
		stored: StoredClaudeStatus;
	};
	t.is(seen.statusKey, 'repo-STA-1');
	t.like(seen.stored, {
		kind: 'state',
		state: {
			sessionId: 'session-1',
			workspaceName: 'repo-STA-1',
			status: 'running_tool',
			currentTool: 'Bash',
			event: 'PreToolUse',
			cwd: '/work/STA-1',
		},
	});
	t.false(fs.existsSync(path.join(stateDir, 'claude-status')));
});
