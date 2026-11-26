import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {
	killProcessesNaming,
	processesNaming,
} from '../test/helpers/processes.ts';
import {teardown} from '../test/helpers/teardown.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	TEST_TMUX_GUARD,
	TEST_TMUX_REFUSALS,
} from '../test/helpers/test-run-env.ts';

const guardScript = path.resolve('test/helpers/tmux-guard.sh');
const setupScript = path.resolve('test/helpers/tmux-guard-env.sh');
const uid = process.getuid!();
// Where tmux puts named sockets when TMUX_TMPDIR is unset. Safe to name as
// the live directory here: the tmux these tests run is a fake.
const tmpLiveDir = `${fs.realpathSync('/tmp')}/tmux-${uid}`;

type Run = {
	status: number | null;
	stderr: string;
	argv?: string[];
	refusals: string;
};

/**
 * Runs the guard the way a test run's wrapper does, in front of a fake tmux
 * that records its argv. `live` is the live tmux directory the wrapper
 * names: by default an existing one in the test's temp dir.
 */
function setup() {
	const root = tempDir('tmux-guard-');
	const live = path.join(root, 'live', `tmux-${uid}`);
	const priv = path.join(root, 'private');
	fs.mkdirSync(live, {recursive: true});
	fs.mkdirSync(priv);
	const argvFile = path.join(root, 'argv');
	const fake = path.join(root, 'real-tmux');
	fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`, {
		mode: 0o755,
	});
	const refusalsFile = path.join(root, 'refusals.log');

	const run = (
		args: string[],
		{
			env = {},
			liveDir = live,
			realTmux = fake,
		}: {env?: Record<string, string>; liveDir?: string; realTmux?: string} = {},
	): Run => {
		fs.rmSync(argvFile, {force: true});
		fs.rmSync(refusalsFile, {force: true});
		const liveDirsFile = path.join(root, 'live-dirs');
		fs.writeFileSync(liveDirsFile, `${liveDir}\n`);
		const wrapper = path.join(root, 'tmux');
		fs.writeFileSync(
			wrapper,
			[
				'#!/bin/sh',
				realTmux && `guard_real_tmux='${realTmux}'`,
				liveDir && `guard_live_dirs='${liveDirsFile}'`,
				`guard_shared_log='${path.join(root, 'shared.log')}'`,
				`. '${guardScript}'`,
				'',
			].join('\n'),
			{mode: 0o755},
		);
		const result = spawnSync(wrapper, args, {
			cwd: root,
			encoding: 'utf8',
			env: {
				PATH: process.env['PATH'],
				[TEST_TMUX_REFUSALS]: refusalsFile,
				...env,
			},
		});
		return {
			status: result.status,
			stderr: result.stderr,
			argv: fs.existsSync(argvFile)
				? fs.readFileSync(argvFile, 'utf8').split('\n').slice(0, -1)
				: undefined,
			refusals: fs.existsSync(refusalsFile)
				? fs.readFileSync(refusalsFile, 'utf8')
				: '',
		};
	};

	return {root, live, priv, run};
}

function assertRefused(result: Run, socket: string, args: string[]) {
	const message = `refusing to run tmux against the live tmux directory (${socket}): tmux ${args.join(' ')}\n`;
	expect(result.status).toBe(1);
	expect(result.argv, 'the real tmux ran').toBe(undefined);
	expect(result.stderr).toBe(message);
	expect(result.refusals).toBe(message);
}

function assertPassed(result: Run, args: string[]) {
	expect(result.status, result.stderr).toBe(0);
	expect(result.argv).toStrictEqual(args);
	expect(result.refusals).toBe('');
}

test('refuses a named socket when TMUX_TMPDIR is unset', () => {
	const {run} = setup();
	const args = ['-L', 'pappardelle_inner', 'kill-server'];
	assertRefused(
		run(args, {liveDir: tmpLiveDir}),
		`${tmpLiveDir}/pappardelle_inner`,
		args,
	);
});

test('refuses a named socket when TMUX_TMPDIR was removed, as tmux falls back to /tmp', () => {
	const {root, run} = setup();
	const args = ['-L', 'pappardelle_inner', 'kill-server'];
	assertRefused(
		run(args, {
			liveDir: tmpLiveDir,
			env: {TMUX_TMPDIR: path.join(root, 'removed')},
		}),
		`${tmpLiveDir}/pappardelle_inner`,
		args,
	);
});

test('refuses -L clustered with another flag', () => {
	const {run} = setup();
	const args = ['-NLpappardelle_inner', 'kill-server'];
	assertRefused(
		run(args, {liveDir: tmpLiveDir}),
		`${tmpLiveDir}/pappardelle_inner`,
		args,
	);
});

test('refuses a bare call with neither TMUX nor TMUX_TMPDIR, which uses the default server', () => {
	const {run} = setup();
	assertRefused(
		run(['kill-server'], {liveDir: tmpLiveDir}),
		`${tmpLiveDir}/default`,
		['kill-server'],
	);
});

test('refuses -S paths into the live directory, however they are spelled', () => {
	const {root, live, priv, run} = setup();
	fs.symlinkSync(live, path.join(root, 'link'));
	const spellings = [
		path.join(live, 'pappardelle_inner'),
		path.join(root, 'link', 'pappardelle_inner'),
		`${priv}/../live/tmux-${uid}/pappardelle_inner`,
		`live/tmux-${uid}/pappardelle_inner`,
	];
	for (const socket of spellings) {
		const args = ['-S', socket, 'kill-server'];
		assertRefused(run(args, {env: {TMUX_TMPDIR: priv}}), socket, args);
	}
});

test('refuses -L names and paths that climb into the live directory', () => {
	const {root, live, priv, run} = setup();
	const climb = `../../live/tmux-${uid}/pappardelle_inner`;
	const args = ['-L', climb, 'kill-server'];
	assertRefused(
		run(args, {env: {TMUX_TMPDIR: priv}}),
		`${priv}/tmux-${uid}/${climb}`,
		args,
	);
	const doubled = `/${live}/pappardelle_inner`;
	assertRefused(
		run(['-S', doubled, 'ls'], {env: {TMUX_TMPDIR: root}}),
		doubled,
		['-S', doubled, 'ls'],
	);
});

test('the last -S wins, and -S beats -L', () => {
	const {live, priv, run} = setup();
	const socket = path.join(live, 's');
	for (const args of [
		['-S', path.join(priv, 's'), '-S', socket, 'kill-server'],
		['-L', 'x', `-S${socket}`, 'kill-server'],
	]) {
		assertRefused(run(args, {env: {TMUX_TMPDIR: priv}}), socket, args);
	}
});

test('refuses a bare call whose TMUX names a live socket', () => {
	const {live, priv, run} = setup();
	const socket = path.join(live, 'pappardelle_inner');
	assertRefused(
		run(['kill-server'], {env: {TMUX: `${socket},123,0`, TMUX_TMPDIR: priv}}),
		socket,
		['kill-server'],
	);
});

test('fails closed when the wrapper names no live directory or real tmux', () => {
	const {priv, run} = setup();
	for (const missing of [{liveDir: ''}, {realTmux: ''}]) {
		const result = run(['-L', 'x', 'ls'], {
			...missing,
			env: {TMUX_TMPDIR: priv},
		});
		expect(result.status).toBe(1);
		expect(result.argv).toBe(undefined);
		expect(result.stderr).toMatch(/^tmux guard: /);
	}
});

test('runs the real tmux with argv intact for sockets outside the live directory', () => {
	const {root, live, priv, run} = setup();
	const cases: Array<[string[], Record<string, string>]> = [
		[['-L', 'x', 'new-session', '-d'], {TMUX_TMPDIR: priv}],
		[['-S', path.join(priv, 's'), 'ls'], {}],
		[['-S', path.join(root, 'missing', 's'), 'ls'], {}],
		[['ls'], {TMUX: '', TMUX_TMPDIR: priv}],
		[
			[
				'-f',
				'/dev/null',
				'-L',
				'x',
				'new-session',
				'-d',
				'-s',
				'y',
				`cmd -S ${live}/s`,
			],
			{TMUX_TMPDIR: priv},
		],
	];
	for (const [args, env] of cases) assertPassed(run(args, {env}), args);
});

const guarded = Boolean(process.env[TEST_TMUX_REFUSALS]);

(guarded ? test : test.skip)(
	'a run started inside a test run keeps the outer wrapper',
	() => {
		const wrapper = path.join(process.env[TEST_TMUX_GUARD]!, 'bin', 'tmux');
		const before = fs.readFileSync(wrapper, 'utf8');
		const result = spawnSync(setupScript, {encoding: 'utf8'});
		expect(result.status, result.stderr).toBe(0);
		const tmuxTmpdir = /^export TMUX_TMPDIR='(.*)'$/m.exec(result.stdout)?.[1];
		teardown(() => {
			if (tmuxTmpdir) fs.rmSync(tmuxTmpdir, {recursive: true, force: true});
		});
		expect(result.stdout).toMatch(
			new RegExp(`^export PATH='${path.dirname(wrapper)}:`, 'm'),
		);
		expect(tmuxTmpdir).toBeTruthy();
		expect(tmuxTmpdir).not.toBe(process.env['TMUX_TMPDIR']);
		expect(fs.readFileSync(wrapper, 'utf8')).toBe(before);
	},
);

/** Where the live tmux directories setup has recorded are, for those that exist. */
function liveBases(): string[] {
	return fs
		.readFileSync(path.join(process.env[TEST_TMUX_GUARD]!, 'live-dirs'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(live => path.dirname(live))
		.filter(base => fs.existsSync(base));
}

(guarded ? test : test.skip)(
	"the run's own wrapper refuses every live directory setup recorded",
	() => {
		const guardHome = process.env[TEST_TMUX_GUARD]!;
		const refusals = path.join(tempDir('tmux-guard-run-'), 'refusals.log');
		const bases = liveBases();
		expect(bases.length > 0).toBe(true);
		for (const base of bases) {
			// A named socket, since a live directory doesn't exist until its
			// first server starts.
			const result = spawnSync(
				path.join(guardHome, 'bin', 'tmux'),
				['-L', 'guard-test-no-such-server', 'ls'],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						TMUX_TMPDIR: base,
						[TEST_TMUX_REFUSALS]: refusals,
					},
				},
			);
			expect(result.status, base).toBe(1);
			expect(result.stderr).toMatch(
				/^refusing to run tmux against the live tmux directory/,
			);
		}
	},
);

const runScript = path.resolve('test/helpers/tmux-guard-run.sh');

function runGuarded(script: string) {
	return spawnSync(runScript, ['sh', '-c', script], {encoding: 'utf8'});
}

(guarded ? test : test.skip)(
	'a suite run under the guard fails on a refused call it swallowed',
	() => {
		const base = liveBases()[0]!;
		const result = runGuarded(
			`TMUX_TMPDIR='${base}' tmux -L guard-test-no-such-server ls; true`,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'refusing to run tmux against the live tmux directory',
		);
	},
);

(guarded ? test : test.skip)(
	'a suite that passed but left a tmux server running fails, and the server is stopped',
	() => {
		const name = `guard-run-leak-${process.pid}`;
		teardown(() => {
			killProcessesNaming(name);
		});
		const result = runGuarded(
			`echo "$TMUX_TMPDIR"; tmux -f /dev/null -L ${name} new-session -d 'sleep 60'`,
		);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain(`Stopped a tmux server left running on`);
		expect(fs.existsSync(result.stdout.trim())).toBe(false);
		expect(processesNaming(name)).toEqual([]);
	},
);

(guarded ? test : test.skip)(
	"a suite run under the guard exits with the suite's own status",
	() => {
		expect(runGuarded('exit 3').status).toBe(3);
	},
);

(guarded ? test : test.skip)(
	'finishing a run leaves alone a directory the guard did not create',
	() => {
		const outside = tempDir('finish-outside-');
		const socket = path.join(outside, 's');
		const tmux = (...args: string[]) =>
			spawnSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
				encoding: 'utf8',
			});
		teardown(() => {
			tmux('kill-server');
		});
		expect(tmux('new-session', '-d', 'sleep 60').status).toBe(0);
		const result = spawnSync(
			setupScript,
			['--finish', path.join(outside, 'refusals.log'), '--fail-on-leaks'],
			{encoding: 'utf8'},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('is not in a private TMUX_TMPDIR');
		expect(tmux('has-session').status).toBe(0);
		expect(fs.existsSync(outside)).toBe(true);
	},
);
