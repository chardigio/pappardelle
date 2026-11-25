import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {spawnQuietCommand} from './quiet-command.ts';

test('verbose lifecycle commands finish without buffering output or blocking UI timers', async () => {
	const child = spawnQuietCommand(
		process.execPath,
		[
			'-e',
			`
const fs = require('node:fs');
const chunk = Buffer.alloc(64 * 1024, 'x');
for (let i = 0; i < 1024; i++) {
  fs.writeSync(1, chunk);
  fs.writeSync(2, chunk);
}
setTimeout(() => process.exit(0), 150);
`,
		],
		{detached: true, timeout: 5000},
	);
	teardown(() => child.kill());
	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	teardown(() => clearInterval(timer));

	const [code, signal] = await once(child, 'close');
	expect(code).toBe(0);
	expect(signal).toBe(null);
	expect(ticks >= 5).toBe(true);
	// With no parent-side streams, output cannot accumulate in memory or reach the TUI.
	expect(child.stdout).toBe(null);
	expect(child.stderr).toBe(null);
});

test('preserves cwd, environment, arguments, and nonzero exit codes', async () => {
	const child = spawnQuietCommand(
		process.execPath,
		[
			'-e',
			`process.exit(process.cwd() === require('node:fs').realpathSync(process.argv[1]) && process.env.QUIET_COMMAND_TEST === 'present' ? 23 : 99)`,
			os.tmpdir(),
		],
		{cwd: os.tmpdir(), env: {...process.env, QUIET_COMMAND_TEST: 'present'}},
	);
	expect(await once(child, 'close')).toStrictEqual([23, null]);
});

test('reports spawn failure', async () => {
	const child = spawnQuietCommand(
		path.join(os.tmpdir(), 'nonexistent-pappardelle-command', 'missing'),
		[],
		{},
	);
	const [error] = (await once(child, 'error')) as [NodeJS.ErrnoException];
	expect(error.code).toBe('ENOENT');
});

test('preserves the subprocess timeout', async () => {
	const child = spawnQuietCommand(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)'],
		{timeout: 100},
	);
	teardown(() => child.kill());
	expect(await once(child, 'close')).toStrictEqual([null, 'SIGTERM']);
});

test('inherited output descriptors do not delay foreground completion', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-quiet-'));
	const pidFile = path.join(dir, 'pid');
	teardown(() => {
		if (fs.existsSync(pidFile)) {
			try {
				process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
			} catch {}
		}
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const child = spawnQuietCommand(
		process.execPath,
		[
			'-e',
			`
const child = require('node:child_process').spawn(
  process.execPath, ['-e', 'setTimeout(() => {}, 2000)'],
  {detached: true, stdio: 'inherit'},
);
require('node:fs').writeFileSync(process.argv[1], String(child.pid));
child.unref();
`,
			pidFile,
		],
		{},
	);
	expect(await once(child, 'close')).toStrictEqual([0, null]);
	expect(() =>
		process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0),
	).not.toThrow();
});
