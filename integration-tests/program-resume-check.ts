// OSC 7577 end to end on a private tmux server: programs in a space's agent
// pane, companion main pane and a `companion run` split report how to resume,
// the server dies, and each pane comes back running its record. Then the
// rules that keep records honest: a replaced pane, a closed split, an owner
// that exits, reports with the wrong token or an older time, a space close.
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
	closeSync,
} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
	closeCompanionPane,
	resizeCompanionPane,
	runInCompanion,
} from '../source/companion.ts';
import {getRepoName} from '../source/config.ts';
import {
	DEFAULT_RESOLVED_AGENT_PROFILE,
	type ResolvedAgentProfile,
} from '../source/config.ts';
import {statusSocket} from '../source/program-status-monitor.ts';
import {newSpaceIdentity, sessionNamesFor} from '../source/space-identity.ts';
import {forgetClosedSpace} from '../source/space-cleanup.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {resumeDir} from '../source/resume-launch.ts';
import {buildResumeReport} from '../source/program-resume.ts';
import {
	ensureAgentSession,
	ensureCompanionSession,
	initTmuxState,
	socketTmuxRunner,
	syncCompanionSplits,
} from '../source/tmux.ts';
import {
	defaultRestartCommandDeps,
	hardRestart,
} from '../source/restart-command.ts';
import {
	StatusHarness,
	projectRoot,
	untilSeen,
} from './program-status-harness.ts';
import {execFileSync} from 'node:child_process';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
try {
	const worktree = path.join(harness.root, 'worktree');
	const out = path.join(harness.root, 'out');
	mkdirSync(worktree);
	mkdirSync(out);
	execFileSync('git', ['init', '--quiet', worktree]);
	process.chdir(worktree);
	const repo = getRepoName();
	const daos = createStateDaos({repo, stateDir: harness.stateDir});
	initTmuxState(daos);
	const key = 'qa-resume';
	const sessions = sessionNamesFor(key, repo);
	await daos.spaceIdentities.record(
		newSpaceIdentity({
			repo,
			key,
			worktreePath: worktree,
			socket: statusSocket(),
		}),
	);
	await daos.registry.add(key);
	const fixture = path.join(
		projectRoot,
		'integration-tests/program-resume-fixture.sh',
	);
	const run = (name: string, ...args: string[]) =>
		[fixture, out, name, ...args].map(arg => `'${arg}'`).join(' ');
	const profile = (command: string): ResolvedAgentProfile => ({
		...DEFAULT_RESOLVED_AGENT_PROFILE,
		name: 'fixture',
		command,
		args: '',
		isClaude: false,
		resumeArgs: '',
	});
	const argvOf = (name: string) => {
		try {
			return readFileSync(path.join(out, `${name}.argv`), 'utf8')
				.split('\0')
				.slice(2, -1);
		} catch {
			return undefined;
		}
	};
	const started = async (name: string, args: string[], what: string) => {
		await untilSeen(
			() => argvOf(name),
			value => JSON.stringify(value) === JSON.stringify(args),
			what,
			20_000,
		);
	};
	const records = (pane: Parameters<typeof daos.resumeRecords.read>[1]) =>
		daos.resumeRecords.read(key, pane).records;
	const recorded = async (
		pane: Parameters<typeof daos.resumeRecords.read>[1],
		args: string[],
		what: string,
	) =>
		untilSeen(
			() => records(pane),
			value =>
				value.length === 1 &&
				JSON.stringify(value[0]!.argv.slice(3)) === JSON.stringify(args),
			what,
			20_000,
		);
	const agent = {kind: 'agent'} as const;
	const main = {kind: 'main'} as const;
	const logs = {kind: 'split', name: 'logs'} as const;

	assert.ok(
		await ensureAgentSession(
			key,
			worktree,
			false,
			undefined,
			profile(run('agent', 'first')),
		),
	);
	await started('agent', ['first'], 'the agent starts');
	await recorded(agent, ['first'], "the agent's report is recorded");
	assert.equal(records(agent)[0]!.cwd, worktree);
	assert.equal(
		// eslint-disable-next-line no-bitwise -- Permission bits.
		statSync(path.join(harness.stateDir, 'state.db')).mode & 0o777,
		0o600,
	);
	assert.equal(readFileSync(path.join(out, 'agent.token'), 'utf8').length, 43);
	console.log(
		'PASS the agent pane gets a token and its report becomes a record',
	);

	assert.ok(await ensureCompanionSession(key, worktree, run('main', 'one')));
	await recorded(main, ['one'], "the companion main pane's report is recorded");
	runInCompanion(key, {
		pane: 'logs',
		split: 'right',
		size: '30%',
		command: run('logs', 'one'),
	});
	await recorded(logs, ['one'], "the split's report is recorded");
	resizeCompanionPane(key, {pane: 'logs', size: '40%'});
	await untilSeen(
		() => daos.resumeRecords.splitsWithRecords(key),
		splits => splits[0]?.arrangement.size === '40%',
		'a resize after the last report is kept',
	);
	console.log(
		'PASS companion panes record their reports, and a split keeps its arrangement',
	);

	// `restart --hard` ends the server; the records outlive it.
	const inner = socketTmuxRunner(harness.socket);
	assert.equal(
		await hardRestart(true, {
			...defaultRestartCommandDeps(),
			tmux: inner,
			innerTmux: inner,
			knownRepos: () => [],
			onInnerServer: false,
			print() {},
		}),
		0,
	);
	await delay(1000);
	for (const pane of [agent, main, logs]) assert.equal(records(pane).length, 1);
	for (const name of ['agent', 'main', 'logs'])
		rmSync(path.join(out, `${name}.argv`));
	console.log('PASS records survive restart --hard');

	assert.ok(
		await ensureAgentSession(
			key,
			worktree,
			false,
			undefined,
			profile(run('agent', 'fallback')),
		),
	);
	await started(
		'agent',
		['first'],
		'the agent pane restores its record, not the profile command',
	);
	assert.ok(
		await ensureCompanionSession(key, worktree, run('main', 'fallback')),
	);
	await started('main', ['one'], 'the companion main pane restores its record');
	await syncCompanionSplits(
		{agentViewerPaneId: '', companionViewerPaneId: ''},
		key,
		{seed: () => []},
	);
	await started(
		'logs',
		['one'],
		'the companion run split comes back and restores its record',
	);
	const split = (option: string) =>
		execFileSync(
			'tmux',
			[
				'-L',
				harness.socket,
				'show-options',
				'-v',
				'-t',
				`=${sessions.companion}~logs:`,
				option,
			],
			{encoding: 'utf8'},
		).trim();
	assert.equal(split('@pappa_split'), 'right');
	assert.equal(split('@pappa_size'), '40%');
	assert.equal(
		readFileSync(path.join(out, 'agent.cwd'), 'utf8').trim(),
		worktree,
	);
	// The restored programs report again, under their new pids.
	await recorded(agent, ['first'], 'the restored agent reports again');
	console.log(
		'PASS every pane comes back from its record after the server died',
	);

	// Reports the agent pane's monitor must ignore: another token, an older time.
	const token = readFileSync(path.join(out, 'agent.token'), 'utf8');
	const owner = records(agent)[0]!;
	const tty = execFileSync(
		'tmux',
		[
			'-L',
			harness.socket,
			'display-message',
			'-p',
			'-t',
			`=${sessions.agent}:`,
			'#{pane_tty}',
		],
		{encoding: 'utf8'},
	).trim();
	const send = (time: number, args: string[], withToken: string) => {
		const fd = openSync(tty, 'w');
		writeSync(
			fd,
			buildResumeReport(
				{pid: owner.pid, time, argv: [fixture, out, 'agent', ...args]},
				withToken,
			),
		);
		closeSync(fd);
	};
	const now = Math.floor(Date.now() / 1000);
	send(now + 1, ['newer'], token);
	await recorded(
		agent,
		['newer'],
		"a fresh report with the pane's token replaces the record",
	);
	send(now, ['older'], token);
	send(now + 2, ['forged'], 'not-the-token');
	await delay(1500);
	assert.deepEqual(records(agent)[0]!.argv.slice(3), ['newer']);
	const traced = readdirSync(path.join(harness.root, 'trace'))
		.flatMap(name =>
			readFileSync(path.join(harness.root, 'trace', name), 'utf8')
				.split('\n')
				.filter(Boolean),
		)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry['type'] === 'resume');
	for (const outcome of ['accepted', 'ignored: stale', 'ignored: mac'])
		assert.ok(
			traced.some(entry => entry['outcome'] === outcome),
			`the status trace records ${outcome}`,
		);
	assert.ok(traced.every(entry => !('body' in entry)));
	console.log(
		'PASS reports with another token or an older time change nothing',
	);

	// A replaced pane drops its records and the new program's report is taken.
	runInCompanion(key, {
		pane: 'logs',
		split: 'right',
		command: run('logs', 'two'),
	});
	await recorded(logs, ['two'], "the replacing program's report is recorded");
	closeCompanionPane(key, 'logs');
	await untilSeen(
		() => records(logs),
		value => value.length === 0,
		'closing the split drops its records',
	);
	console.log('PASS replacing and closing a split');

	// The owner exits on its own: its record goes after the grace window.
	const mainPid = Number(readFileSync(path.join(out, 'main.pid'), 'utf8'));
	process.kill(mainPid, 'SIGKILL');
	await untilSeen(
		() => records(main),
		value => value.length === 0,
		'an owner that exits loses its record',
		20_000,
	);
	console.log('PASS an owner that exits loses its record');

	// After the next server death, `companion run` on a split that left a
	// record runs the command it was given, and a split killed from outside
	// while the server runs takes its records with it.
	const notes = {kind: 'split', name: 'notes'} as const;
	runInCompanion(key, {
		pane: 'notes',
		split: 'down',
		command: run('notes', 'one'),
	});
	await recorded(notes, ['one'], "the notes split's report is recorded");
	await harness.tmux(['kill-server']);
	await delay(1000);
	assert.equal(records(notes).length, 1);
	assert.ok(
		await ensureCompanionSession(key, worktree, run('main', 'fallback')),
	);
	runInCompanion(key, {
		pane: 'notes',
		split: 'down',
		command: run('notes', 'asked'),
	});
	await started(
		'notes',
		['asked'],
		'companion run runs the command it was given',
	);
	await recorded(notes, ['asked'], 'and its report replaces the old record');
	await harness.tmux(['kill-session', '-t', `=${sessions.companion}~notes:`]);
	await untilSeen(
		() => records(notes),
		value => value.length === 0,
		'a split killed from outside drops its records',
	);
	console.log(
		'PASS companion run over an old record, and a split killed from outside',
	);

	// Closing the space forgets everything it left.
	await forgetClosedSpace(daos, repo, key);
	for (const pane of [agent, main, logs, notes])
		assert.equal(records(pane).length, 0);
	assert.ok(!existsSync(resumeDir(daos.stateDir, repo, key)));
	console.log('PASS a space close forgets its records');
} finally {
	process.chdir(originalDirectory);
	await harness.cleanup();
}
