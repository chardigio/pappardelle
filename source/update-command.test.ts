import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {OuterTmuxRunner} from './tmux.ts';
import {
	currentOuterSession,
	outerTmuxEnv,
	runUpdateCommand,
	type UpdateCommandDeps,
} from './update-command.ts';

let counter = 0;
function temporaryDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`update-command-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

type Harness = {
	deps: UpdateCommandDeps;
	tmuxCalls: string[][];
	printed: string[];
	confirmCalls: string[];
};

function harness(
	options: {
		installerStatus?: number;
		sessions?: string[];
		listFails?: boolean;
		repos?: string[];
		currentSession?: string | null;
		isTTY?: boolean;
		confirmAnswer?: boolean;
	} = {},
): Harness {
	const repoStateRoot = temporaryDir();
	for (const repo of options.repos ?? []) {
		fs.mkdirSync(path.join(repoStateRoot, repo));
	}

	const tmuxCalls: string[][] = [];
	const printed: string[] = [];
	const confirmCalls: string[] = [];
	const tmux: OuterTmuxRunner = args => {
		tmuxCalls.push([...args]);
		if (args[0] === 'list-sessions') {
			return options.listFails
				? {status: 1, stdout: ''}
				: {status: 0, stdout: (options.sessions ?? []).join('\n') + '\n'};
		}

		return {status: 0, stdout: ''};
	};

	return {
		tmuxCalls,
		printed,
		confirmCalls,
		deps: {
			installedVersion: 'v1.2.3',
			runInstaller: () => options.installerStatus ?? 0,
			tmux,
			repoStateRoot,
			currentSession: () => options.currentSession ?? null,
			isTTY: options.isTTY ?? false,
			async confirm(question) {
				confirmCalls.push(question);
				return options.confirmAnswer ?? false;
			},
			print(line) {
				printed.push(line);
			},
		},
	};
}

function killed(h: Harness): string[] {
	return h.tmuxCalls
		.filter(args => args[0] === 'kill-session')
		.map(args => args.at(-1)!);
}

test('a failed install returns its status and leaves tmux alone', async t => {
	const h = harness({
		installerStatus: 3,
		sessions: ['pappardelle-app'],
		repos: ['app'],
	});

	t.is(await runUpdateCommand({killTuis: true}, h.deps), 3);
	t.deepEqual(h.tmuxCalls, []);
});

test('only pappardelle sessions with a repo state dir count as running TUIs', async t => {
	const h = harness({
		sessions: [
			'pappardelle-app',
			'pappardelle-decoy',
			'claude-app-STA-1',
			'pappardelle-web',
		],
		repos: ['app', 'web'],
	});

	await runUpdateCommand({killTuis: true}, h.deps);

	t.deepEqual(killed(h), ['pappardelle-app', 'pappardelle-web']);
});

test('--kill-tuis quits the session running the command last', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web', 'pappardelle-api'],
		repos: ['app', 'web', 'api'],
		currentSession: 'pappardelle-app',
	});

	t.is(await runUpdateCommand({killTuis: true}, h.deps), 0);
	t.deepEqual(killed(h), [
		'pappardelle-web',
		'pappardelle-api',
		'pappardelle-app',
	]);
});

test('--no-kill-tuis leaves TUIs running and names them in a restart hint', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		isTTY: true,
	});

	t.is(await runUpdateCommand({killTuis: false}, h.deps), 0);
	t.deepEqual(killed(h), []);
	t.deepEqual(h.confirmCalls, []);
	const hint = h.printed.at(-1)!;
	t.true(hint.includes('pappardelle-app'));
	t.true(hint.includes('pappardelle-web'));
});

test('on a TTY with no flag, a yes to the prompt quits the TUIs', async t => {
	const h = harness({
		sessions: ['pappardelle-app', 'pappardelle-web'],
		repos: ['app', 'web'],
		isTTY: true,
		confirmAnswer: true,
	});

	await runUpdateCommand({}, h.deps);

	t.is(h.confirmCalls.length, 1);
	t.true(h.confirmCalls[0]!.includes('2'));
	t.deepEqual(killed(h), ['pappardelle-app', 'pappardelle-web']);
});

test('on a TTY with no flag, a no to the prompt prints the hint instead', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		isTTY: true,
		confirmAnswer: false,
	});

	await runUpdateCommand({}, h.deps);

	t.is(h.confirmCalls.length, 1);
	t.deepEqual(killed(h), []);
	t.true(h.printed.at(-1)!.includes('pappardelle-app'));
});

test('without a TTY or a flag, it never prompts and prints the hint', async t => {
	const h = harness({
		sessions: ['pappardelle-app'],
		repos: ['app'],
		isTTY: false,
	});

	await runUpdateCommand({}, h.deps);

	t.deepEqual(h.confirmCalls, []);
	t.deepEqual(killed(h), []);
	t.true(h.printed.at(-1)!.includes('pappardelle-app'));
});

test('no running TUIs means no prompt and no hint', async t => {
	const h = harness({sessions: ['claude-app-STA-1'], isTTY: true});

	t.is(await runUpdateCommand({}, h.deps), 0);
	t.deepEqual(h.confirmCalls, []);
	t.false(h.printed.some(line => line.includes('old build')));
});

test('a tmux server that is not running is treated as no TUIs', async t => {
	const h = harness({listFails: true, repos: ['app']});

	t.is(await runUpdateCommand({killTuis: true}, h.deps), 0);
	t.deepEqual(killed(h), []);
});

test('the opening line names the version being replaced when known', async t => {
	const h = harness();
	await runUpdateCommand({}, h.deps);
	t.true(h.printed[0]!.includes('v1.2.3'));

	const unknown = harness();
	unknown.deps.installedVersion = null;
	await runUpdateCommand({}, unknown.deps);
	t.false(unknown.printed[0]!.includes('currently on'));
});

// ============================================================================
// Reaching the outer tmux server from an inner pane
// ============================================================================

test('outer tmux calls drop TMUX so an inner pane still reaches the default server', t => {
	const env = outerTmuxEnv({
		TMUX: '/private/tmp/tmux-502/pappardelle_inner,59729,4',
		TMUX_PANE: '%4',
		TMUX_TMPDIR: '/scratch/tmux',
		HOME: '/home/me',
	});

	t.false('TMUX' in env);
	t.false('TMUX_PANE' in env);
	t.is(env['TMUX_TMPDIR'], '/scratch/tmux');
	t.is(env['HOME'], '/home/me');
});

test('the current outer session is unknown when TMUX names a non-default socket', t => {
	const tmuxTmpdir = temporaryDir();
	const uid = process.getuid?.() ?? 0;
	const socketDir = path.join(tmuxTmpdir, `tmux-${uid}`);
	fs.mkdirSync(socketDir);
	fs.writeFileSync(path.join(socketDir, 'default'), '');
	fs.writeFileSync(path.join(socketDir, 'pappardelle_inner'), '');

	const queried: string[][] = [];
	const tmux: OuterTmuxRunner = args => {
		queried.push([...args]);
		return {status: 0, stdout: 'pappardelle-app\n'};
	};

	t.is(
		currentOuterSession(
			{
				TMUX: `${path.join(socketDir, 'pappardelle_inner')},1,0`,
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
		null,
	);
	t.deepEqual(queried, []);

	t.is(
		currentOuterSession(
			{
				TMUX: `${path.join(socketDir, 'default')},1,0`,
				TMUX_PANE: '%3',
				TMUX_TMPDIR: tmuxTmpdir,
			},
			tmux,
		),
		'pappardelle-app',
	);
	t.deepEqual(queried, [
		['display-message', '-p', '-t', '%3', '#{session_name}'],
	]);
	t.is(currentOuterSession({TMUX_TMPDIR: tmuxTmpdir}, tmux), null);
});
