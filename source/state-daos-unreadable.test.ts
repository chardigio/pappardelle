import fs from 'node:fs';
import test, {type ExecutionContext} from 'ava';
import {publishSnapshot, snapshotOf} from '../test/helpers/program-status.ts';
import {testState} from '../test/helpers/state.ts';
import {waitUntil} from '../test/helpers/wait.ts';
import type {ClaudeSessionState} from './claude-status.ts';
import {clearRecentErrors, subscribeToErrors} from './logger.ts';
import {parseStatusPane} from './program-status-monitor.ts';
import {stateDbPath} from './state-db.ts';
import {WorkspaceStatuses} from './workspace-status.ts';

const pane = parseStatusPane('%1\t12\t0\t1\t12.owner', 'test-status')!;

/** Stores with the flag on, over a state.db that SQLite refuses to open. */
function unreadable(t: ExecutionContext) {
	const state = testState(t, {sqlite: true});
	const dbPath = stateDbPath(state.stateDir);
	fs.writeFileSync(dbPath, 'not a database '.repeat(600));
	return {...state, dbPath};
}

const session = (workspaceName: string): ClaudeSessionState => ({
	sessionId: 'test-session',
	workspaceName,
	status: 'processing',
	lastUpdate: Date.now(),
});

// Serial: the warnings are counted in the process's one list of them.
test.serial(
	'a read over a database that cannot be read answers nothing known, and each store says so once',
	async t => {
		const {daos} = unreadable(t);
		clearRecentErrors();
		const warned: string[] = [];
		t.teardown(
			subscribeToErrors(errors => {
				const latest = errors.at(-1);
				if (latest) warned.push(`${latest.component}: ${latest.message}`);
			}),
		);

		for (let round = 0; round < 2; round++) {
			t.deepEqual(daos.claudeStatus.readState('repo-STA-1'), {
				kind: 'unreadable',
			});
			t.is(await daos.claudeStatus.read('repo-STA-1'), null);
			t.is(daos.claudeStatus.readableKey('repo', 'STA-1'), 'repo-STA-1');
			t.is(daos.spaceState.read('STA-1'), null);
			t.is(daos.issueMeta.read('STA-1'), null);
			t.deepEqual(daos.stateColors.load(), {});
			t.is(daos.agentSessions.read('STA-1', 'claude'), undefined);
			t.is(daos.agentSessions.latestProfile('STA-1'), undefined);
			t.deepEqual(daos.agentSessions.keys(), []);
			t.deepEqual(daos.companionWidths.all(), {});
			t.is(daos.companionWidths.get('STA-1'), null);
			t.is(daos.companionRequests.answerTo('request-1'), null);
			t.is(daos.schedules.load('job-1'), null);
			t.deepEqual(daos.schedules.list(), []);
			t.is(daos.schedules.queued('STA-1'), null);
			t.is(daos.prLinkStamp.read(), 0);
			t.is(daos.programStatus.read('STA-1', pane), null);
			t.is(daos.tuiMarker.read(), null);
			t.is(daos.updateCheck.read(), null);
		}

		t.deepEqual(
			warned.sort(),
			[
				'agent-sessions: Could not read agent sessions from the state database',
				'claude-status: Could not read Claude statuses from the state database',
				'companion-width: Could not read companion requests from the state database',
				'companion-width: Could not read companion widths from the state database',
				'issue-meta: Could not read issue metadata from the state database',
				'pr-link-stamp: Could not read the pr-link stamp from the state database',
				'program-status: Could not read program statuses from the state database',
				'schedule: Could not read scheduled jobs from the state database',
				'space-state: Could not read space state from the state database',
				'state-colors: Could not read workflow state colors from the state database',
				'tui-marker: Could not read the TUI marker from the state database',
				'update-check: Could not read the update check from the state database',
			].sort(),
		);
	},
);

test('the registry reports a database that cannot be read as a failed read, not as no spaces', async t => {
	const {daos} = unreadable(t);
	t.false(daos.registry.protectedSpaces().ok);
	t.throws(() => daos.registry.openSpaces());
	await t.throwsAsync(daos.registry.openSpacesAsync());
	t.true(daos.registry.has('STA-1'));
});

test('waiting for a change over a database that cannot be read runs out its time', async t => {
	const {daos} = unreadable(t);
	const started = performance.now();
	await daos.claudeStatus.waitForChange(60);
	await daos.programStatus.waitForChange(60);
	t.true(performance.now() - started >= 100);
});

test('watches begun over a database that cannot be read deliver its changes once it can', async t => {
	const state = unreadable(t);
	const {daos, dbPath} = state;
	const seen = {
		claude: [] as string[],
		program: [] as string[],
		highlight: [] as string[],
		requests: [] as string[],
	};
	const stops: Array<() => void> = [];
	t.teardown(() => {
		for (const stop of stops) stop();
	});
	t.notThrows(() => {
		stops.push(
			daos.claudeStatus.watch(key => seen.claude.push(key)),
			daos.programStatus.watch(key => seen.program.push(key)),
			daos.highlight.watch(key => seen.highlight.push(key)),
			daos.companionRequests.watch(request => seen.requests.push(request.id)),
			// The rail's own subscription, which the app makes in an effect. No
			// key is relevant to it, so it reads no status and runs no tmux.
			new WorkspaceStatuses(
				daos.programStatus,
				key => key,
				daos.claudeStatus,
				async () => {
					throw new Error('This test runs no tmux');
				},
			).watch(
				() => {},
				() => false,
			),
		);
	});

	fs.rmSync(dbPath);
	// Requests already in the database a watch comes to read were made for
	// an earlier TUI, as they are when a watch begins over a readable one.
	await daos.highlight.request('STA-1');
	await daos.companionRequests.send({
		id: 'request-0',
		space: 'STA-1',
		kind: 'width',
	});
	await daos.claudeStatus.write(session('repo-STA-1'));
	publishSnapshot(
		state,
		snapshotOf({repo: 'repo', key: 'STA-1', pane}, [
			{state: 'working', id: ''},
		]),
	);
	await waitUntil(
		() => seen.claude.includes('repo-STA-1') && seen.program.includes('STA-1'),
		'what was written while the watches could not read',
	);

	await daos.claudeStatus.write(session('repo-STA-2'));
	await daos.highlight.request('STA-2');
	await daos.companionRequests.send({
		id: 'request-1',
		space: 'STA-2',
		kind: 'width',
	});
	await waitUntil(
		() =>
			seen.claude.includes('repo-STA-2') &&
			seen.highlight.length > 0 &&
			seen.requests.length > 0,
		'a change made after the watches could read',
	);
	t.deepEqual(seen, {
		claude: ['repo-STA-1', 'repo-STA-2'],
		program: ['STA-1'],
		highlight: ['STA-2'],
		requests: ['request-1'],
	});
});
