import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {spawnQuietCommand} from './quiet-command.ts';

test('verbose lifecycle commands finish without buffering output or blocking UI timers', async t => {
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
	t.teardown(() => child.kill());
	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	t.teardown(() => clearInterval(timer));

	const [code, signal] = await once(child, 'close');
	t.is(code, 0);
	t.is(signal, null);
	t.true(ticks >= 5);
	// With no parent-side streams, output cannot accumulate in memory or reach Ink.
	t.is(child.stdout, null);
	t.is(child.stderr, null);
});

test('preserves cwd, environment, arguments, and nonzero exit codes', async t => {
	const child = spawnQuietCommand(
		process.execPath,
		[
			'-e',
			`process.exit(process.cwd() === require('node:fs').realpathSync(process.argv[1]) && process.env.QUIET_COMMAND_TEST === 'present' ? 23 : 99)`,
			os.tmpdir(),
		],
		{cwd: os.tmpdir(), env: {...process.env, QUIET_COMMAND_TEST: 'present'}},
	);
	t.deepEqual(await once(child, 'close'), [23, null]);
});

test('reports spawn failure', async t => {
	const child = spawnQuietCommand(
		path.join(os.tmpdir(), 'nonexistent-pappardelle-command', 'missing'),
		[],
		{},
	);
	const [error] = (await once(child, 'error')) as [NodeJS.ErrnoException];
	t.is(error.code, 'ENOENT');
});

test('preserves the subprocess timeout', async t => {
	const child = spawnQuietCommand(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)'],
		{timeout: 100},
	);
	t.teardown(() => child.kill());
	t.deepEqual(await once(child, 'close'), [null, 'SIGTERM']);
});

test('inherited output descriptors do not delay foreground completion', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-quiet-'));
	const pidFile = path.join(dir, 'pid');
	t.teardown(() => {
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
	t.deepEqual(await once(child, 'close'), [0, null]);
	t.notThrows(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0));
});
