// Runs the unit tests: bun test across worker processes, in an environment
// of the run's own. test/helpers/test-guard.ts refuses any other.
import fs from 'node:fs';
import path from 'node:path';
import {isHostPappardelleEnv} from '../test/helpers/env.ts';
import {
	TEST_HOME,
	TEST_TMPDIR,
	TEST_TMUX_GUARD,
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
const guardUnsets: string[] = [];
for (const line of guardSetup.stdout.toString().split('\n')) {
	const exported = /^export (\w+)='(.*)'$/.exec(line);
	if (exported)
		guardExports[exported[1]!] = exported[2]!.replaceAll(`'\\''`, "'");
	else if (line.startsWith('unset '))
		guardUnsets.push(...line.split(' ').slice(1));
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
// Bun reads HOME once at startup, so the throwaway HOME has to be in the
// environment the test processes start with. Outside the run tmpdir, so what
// tests leave in HOME doesn't count against its leak check.
const throwawayHome = fs.mkdtempSync('/tmp/ph-');
// Without a .zshrc, a zsh started in a test's tmux pane opens its first-run
// wizard, which takes the keys the test types.
fs.writeFileSync(path.join(throwawayHome, '.zshrc'), '');

const dropped = new Set([
	// TMUX makes a tmux client talk to the server the run was started from.
	'TMUX',
	'TMUX_PANE',
	...guardUnsets,
	// These move the agents' config dirs off HOME, so they would point tests
	// at the developer's own Claude and Codex config.
	'CLAUDE_CONFIG_DIR',
	'CODEX_HOME',
	// tmux reads its config from XDG_CONFIG_HOME, so these would bring the
	// developer's config back past the throwaway HOME.
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_CACHE_HOME',
]);
const env: Record<string, string | undefined> = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !isHostPappardelleEnv(name) && !dropped.has(name),
		),
	),
	PATH: pathWithBun,
	...guardExports,
	HOME: throwawayHome,
	// zsh reads its rc files from ZDOTDIR, past HOME.
	ZDOTDIR: throwawayHome,
	TMPDIR: runTmpdir,
	TMUX_TMPDIR: runTmuxTmpdir,
	[TEST_HOME]: throwawayHome,
	[TEST_TMPDIR]: runTmpdir,
	[TEST_TMUX_TMPDIR]: runTmuxTmpdir,
	// Every git commit and fetch otherwise detaches a `git maintenance run
	// --auto`, which can still be writing into a test's repo after the test
	// removed it. Set through the environment rather than HOME's .gitconfig so
	// it also reaches the gits that tests start under a HOME of their own.
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'maintenance.auto',
	GIT_CONFIG_VALUE_0: 'false',
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
const sharedRefusals = path.join(
	guardExports[TEST_TMUX_GUARD] ?? '',
	'refusals.log',
);
const sharedRefusalsStart =
	fs.statSync(sharedRefusals, {throwIfNoEntry: false})?.size ?? 0;

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
const leaks = [
	...sweepServers(runRoot),
	...sweepServers(runTmuxTmpdir),
	...sweepProcesses(runRoot),
	...sweepProcesses(runTmuxTmpdir),
];
// Teardowns often discard tmux's exit status, so the guard logs each refusal.
const refused = guardRefusals
	? [readFrom(guardRefusals, 0), readFrom(sharedRefusals, sharedRefusalsStart)]
			.join('')
			.split('\n')
			.filter(Boolean)
	: [];
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

// Unlike leaks, a refusal fails even a run that already failed: the test that
// made it would have killed the user's tmux sessions.
if (refused.length > 0) {
	console.error(
		`The test tmux guard refused ${refused.length} tmux calls against the live tmux directory. Give each test its own TMUX_TMPDIR or a -S socket:`,
	);
	for (const line of refused) console.error(`  ${line}`);
}

for (const dir of [runRoot, runTmuxTmpdir, throwawayHome]) {
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
	refused.length > 0 || (testsExit === 0 && leaks.length > 0) ? 1 : testsExit;

function readFrom(file: string, start: number): string {
	// start is a byte offset: the log's size when the run began.
	return fs.existsSync(file)
		? fs.readFileSync(file).subarray(start).toString('utf8')
		: '';
}

/** Stops every tmux server listening on a socket under `root`. */
function sweepServers(root: string): string[] {
	const stopped: string[] = [];
	for (const socket of socketsUnder(root)) {
		// env has no TMUX, so -S is the only server this can reach.
		const stop = Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], {
			env,
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		if (stop.success) stopped.push(`tmux server on ${socket}`);
	}

	return stopped;
}

function socketsUnder(root: string): string[] {
	const sockets: string[] = [];
	for (const entry of fs.readdirSync(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		const file = path.join(entry.parentPath, entry.name);
		// lstat: a symlink a test made could point at a socket outside the run.
		const stat = fs.lstatSync(file, {throwIfNoEntry: false});
		if (stat?.isSocket() && fs.realpathSync(file).startsWith(root + '/'))
			sockets.push(file);
	}

	return sockets;
}

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
