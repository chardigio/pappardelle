// Runs the unit tests: bun test across worker processes, in an environment
// of the run's own. test/helpers/test-guard.ts refuses any other.
import fs from 'node:fs';
import path from 'node:path';
import {makeThrowawayHome, testRunEnv} from '../test/helpers/env.ts';
import {
	TEST_HOME,
	TEST_TMPDIR,
	TEST_TMUX_REFUSALS,
	TEST_TMUX_TMPDIR,
} from '../test/helpers/test-run-env.ts';
import {processesNaming} from '../test/helpers/processes.ts';

const TEST_TIMEOUT_MS = 120_000;
const repoRoot = path.resolve(import.meta.dir, '..');

// A version manager's bun shim finds its config through HOME, so under the
// throwaway HOME it would fail; tests that run bun get this one.
const pathWithBun = [path.dirname(process.execPath), process.env['PATH']].join(
	path.delimiter,
);
// The test tmux guard: tests and everything they start get a tmux that
// refuses the user's own servers, a private TMUX_TMPDIR and no TMUX. A test
// that reached the inner server once ended every agent session the user had
// open. The script reads the TMUX_TMPDIR this run was started with to learn
// which directory is live.
const guardSetup = Bun.spawnSync(
	[path.join(repoRoot, 'test/helpers/tmux-guard-env.sh')],
	{env: {...process.env, PATH: pathWithBun}, stderr: 'inherit'},
);
if (!guardSetup.success)
	throw new Error('Could not set up the test tmux guard');
const guardExports: Record<string, string> = {};
for (const line of guardSetup.stdout.toString().split('\n')) {
	const exported = /^export (\w+)='(.*)'$/.exec(line);
	if (exported)
		guardExports[exported[1]!] = exported[2]!.replaceAll(`'\\''`, "'");
}

// Without tmux the guard sets nothing up and the tmux tests skip themselves.
const guardRefusals = guardExports[TEST_TMUX_REFUSALS];

// Under /tmp rather than os.tmpdir(): on macOS that is a long /var/folders
// path, and the sockets tests create under it would pass the ~104-byte unix
// socket limit.
const runRoot = fs.mkdtempSync('/tmp/ptr-');
const runTmpdir = path.join(runRoot, 'tmp');
fs.mkdirSync(runTmpdir);
// Unguarded, a TMUX_TMPDIR of the run's own still keeps a test's default and
// -L servers off the user's.
const runTmuxTmpdir = guardExports['TMUX_TMPDIR'] ?? path.join(runRoot, 'tmux');
fs.mkdirSync(runTmuxTmpdir, {recursive: true});
// Outside the run tmpdir, so what tests leave in HOME doesn't count against
// its leak check.
const throwawayHome = makeThrowawayHome();

const env: Record<string, string | undefined> = {
	...testRunEnv(throwawayHome),
	PATH: pathWithBun,
	...guardExports,
	TMPDIR: runTmpdir,
	TMUX_TMPDIR: runTmuxTmpdir,
	[TEST_HOME]: throwawayHome,
	[TEST_TMPDIR]: runTmpdir,
	[TEST_TMUX_TMPDIR]: runTmuxTmpdir,
	// Bun keeps transpiled modules under HOME; the developer's cache saves
	// every run from starting cold.
	BUN_RUNTIME_TRANSPILER_CACHE_PATH:
		process.env['BUN_RUNTIME_TRANSPILER_CACHE_PATH'] ??
		path.join(
			process.env['XDG_CACHE_HOME'] ??
				path.join(process.env['HOME'] ?? throwawayHome, '.cache'),
			'bun',
			'@t@',
		),
};

const tests = Bun.spawn(
	[
		process.execPath,
		'test',
		'--parallel',
		`--timeout=${TEST_TIMEOUT_MS}`,
		...process.argv.slice(2),
	],
	{cwd: repoRoot, env, stdio: ['inherit', 'inherit', 'inherit']},
);
// The workers have to stop before the run's directories are swept and
// removed under them.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.on(signal, () => {
		tests.kill(signal);
	});
}

const testsExit = await tests.exited;
// Stops the tmux servers left in the run's directories before the process
// sweep, which would kill a server and leave its panes' children running.
// Teardowns often discard tmux's exit status, so the guard logs each refusal,
// and unlike leaks, a refusal fails even a run that already failed: the test
// that made it would have killed the user's tmux sessions.
const finish = guardRefusals
	? Bun.spawnSync(
			[
				path.join(repoRoot, 'test/helpers/tmux-guard-env.sh'),
				'--finish',
				guardRefusals,
				...(testsExit === 0 ? ['--fail-on-leaks'] : []),
				runRoot,
			],
			{env, stdio: ['ignore', 2, 'inherit']},
		)
	: undefined;
const leaks = [...sweepProcesses(runRoot), ...sweepProcesses(runTmuxTmpdir)];
// A failed or interrupted run stops tests before their own cleanup runs, so
// leftovers then say nothing about the tests.
if (testsExit === 0) {
	leaks.push(...fs.readdirSync(runTmpdir).map(entry => `left ${entry}`));
}

if (testsExit === 0 && leaks.length > 0) {
	console.error(
		`Tests left ${leaks.length} things behind. Remove what a test creates or starts, e.g. with tempDir(prefix) from test/helpers/temp-dir.ts and teardown() from test/helpers/teardown.ts:`,
	);
	for (const leak of leaks) console.error(`  ${leak}`);
}

for (const dir of [runRoot, throwawayHome]) {
	try {
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	} catch (error) {
		// A process the sweep could not stop can still be writing; what it
		// leaves is under /tmp and says nothing about the tests.
		console.warn(`Could not remove ${dir}: ${String(error)}`);
	}
}

process.exitCode =
	finish?.success === false || (testsExit === 0 && leaks.length > 0)
		? 1
		: testsExit;

/** Kills what is still running with `root` in its command line. */
function sweepProcesses(root: string): string[] {
	const killed: string[] = [];
	for (const pid of processesNaming(root)) {
		try {
			process.kill(pid, 'SIGKILL');
			killed.push(`process ${pid}`);
		} catch {}
	}

	return killed;
}
