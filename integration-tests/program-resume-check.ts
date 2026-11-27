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
	syncCompanionSplits,
} from '../source/tmux.ts';
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

	// The server dies; the records outlive it.
	await harness.tmux(['kill-server']);
	await delay(1000);
	for (const pane of [agent, main, logs]) assert.equal(records(pane).length, 1);
	for (const name of ['agent', 'main', 'logs'])
		rmSync(path.join(out, `${name}.argv`));
	console.log('PASS records survive the server');

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

	// Closing the space forgets everything it left.
	await forgetClosedSpace(daos, repo, key);
	for (const pane of [agent, main, logs]) assert.equal(records(pane).length, 0);
	assert.ok(!existsSync(resumeDir(daos.stateDir, repo, key)));
	console.log('PASS a space close forgets its records');
} finally {
	process.chdir(originalDirectory);
	await harness.cleanup();
}
