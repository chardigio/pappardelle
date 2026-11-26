// Loaded first into every test file (bunfig.toml, preload), before any module
// under source/ fixes a path from homedir() or starts tmux. A test file run
// by `bun test` without scripts/unit-tests.ts would write to the real
// ~/.pappardelle and could reach the live tmux server every agent runs in.
import os from 'node:os';
import path from 'node:path';
import {isHostPappardelleEnv} from './env.ts';
import {unguardedTmux} from './tmux-guard-check.ts';
import {
	TEST_HOME,
	TEST_TMPDIR,
	TEST_TMUX_REFUSALS,
	TEST_TMUX_TMPDIR,
} from './test-run-env.ts';

const {env} = process;
const repoRoot = path.resolve(import.meta.dir, '../..');
const problems = [
	env[TEST_HOME] === undefined && 'no throwaway HOME was set up',
	os.homedir() !== env[TEST_HOME] && `HOME is ${os.homedir()}`,
	env['TMUX'] !== undefined && `TMUX is set (${env['TMUX']})`,
	env['TMUX_PANE'] !== undefined && 'TMUX_PANE is set',
	// The test tmux guard refuses the user's own servers for
	// whatever a test starts, not only for the test's own code.
	unguardedTmux(),
	Bun.which('tmux') !== null &&
		path.dirname(env[TEST_TMUX_REFUSALS] ?? '') !== env['TMUX_TMPDIR'] &&
		'the test tmux guard logs refusals outside this run',
	(env['TMUX_TMPDIR'] === undefined ||
		env['TMUX_TMPDIR'] !== env[TEST_TMUX_TMPDIR]) &&
		`TMUX_TMPDIR is ${env['TMUX_TMPDIR'] ?? 'unset'}`,
	(env['TMPDIR'] === undefined || env['TMPDIR'] !== env[TEST_TMPDIR]) &&
		`TMPDIR is ${env['TMPDIR'] ?? 'unset'}`,
	process.cwd() !== repoRoot && `the working directory is ${process.cwd()}`,
	...Object.keys(env)
		.filter(name => isHostPappardelleEnv(name))
		.map(name => `${name} is set`),
].filter(problem => typeof problem === 'string');

if (problems.length > 0) {
	console.error(
		`Refusing to run tests outside the environment scripts/unit-tests.ts sets up (${problems.join('; ')}). Run them with bun run test:unit.`,
	);
	// An exit rather than a throw: a throwing preload is reported and the
	// file's imports could already have run.
	// eslint-disable-next-line unicorn/no-process-exit
	process.exit(1);
}
