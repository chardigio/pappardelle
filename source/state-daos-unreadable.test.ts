import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {testState} from '../test/helpers/state.ts';
import {until} from '../test/helpers/wait.ts';
import {clearRecentErrors, subscribeToErrors} from './logger.ts';
import {stateDbPath} from './state-db.ts';
import {onStateDbChange} from './state-db-watch.ts';
import {WorkspaceStatuses} from './workspace-status.ts';

/** Stores with the flag on, over a state.db that SQLite refuses to open. */
function unreadable() {
	const state = testState({sqlite: true});
	const dbPath = stateDbPath(state.stateDir);
	fs.writeFileSync(dbPath, 'not a database '.repeat(600));
	return {...state, dbPath};
}

// Serial: the warnings are counted in the process's one list of them.
test('a read over a database that cannot be read answers nothing known, and each store says so once', async () => {
	const {daos} = unreadable();
	clearRecentErrors();
	const warned: string[] = [];
	teardown(
		subscribeToErrors(errors => {
			const latest = errors.at(-1);
			if (latest) warned.push(`${latest.component}: ${latest.message}`);
		}),
	);

	for (let round = 0; round < 2; round++) {
		expect(daos.spaceState.read('STA-1')).toBe(null);
		expect(daos.issueMeta.read('STA-1')).toBe(null);
		expect(daos.stateColors.load()).toStrictEqual({});
		expect(daos.agentSessions.read('STA-1', 'claude')).toBe(undefined);
		expect(daos.agentSessions.latestProfile('STA-1')).toBe(undefined);
		expect(daos.agentSessions.keys()).toStrictEqual([]);
		expect(daos.companionWidths.all()).toStrictEqual({});
		expect(daos.companionWidths.get('STA-1')).toBe(null);
		expect(daos.companionRequests.answerTo('request-1')).toBe(null);
		expect(daos.schedules.load('job-1')).toBe(null);
		expect(daos.schedules.list()).toStrictEqual([]);
		expect(daos.schedules.queued('STA-1')).toBe(null);
		expect(daos.prLinkStamp.read()).toBe(0);
		expect(daos.tuiMarker.read()).toBe(null);
		expect(daos.updateCheck.read()).toBe(null);
	}

	expect(warned.sort()).toStrictEqual(
		[
			'agent-sessions: Could not read agent sessions from the state database',
			'companion-width: Could not read companion requests from the state database',
			'companion-width: Could not read companion widths from the state database',
			'issue-meta: Could not read issue metadata from the state database',
			'pr-link-stamp: Could not read the pr-link stamp from the state database',
			'schedule: Could not read scheduled jobs from the state database',
			'space-state: Could not read space state from the state database',
			'state-colors: Could not read workflow state colors from the state database',
			'tui-marker: Could not read the TUI marker from the state database',
			'update-check: Could not read the update check from the state database',
		].sort(),
	);
});

test('the registry reports a database that cannot be read as a failed read, not as no spaces', async () => {
	const {daos} = unreadable();
	expect(daos.registry.protectedSpaces().ok).toBe(false);
	expect(() => daos.registry.openSpaces()).toThrow();
	await rejectionOf(daos.registry.openSpacesAsync());
	expect(daos.registry.has('STA-1')).toBe(true);
});

test('watches begun over a database that cannot be read deliver its changes once it can', async () => {
	const {daos, dbPath} = unreadable();
	const seen = {
		highlight: [] as string[],
		requests: [] as string[],
	};
	const stops: Array<() => void> = [];
	teardown(() => {
		for (const stop of stops) stop();
	});
	expect(() => {
		stops.push(
			daos.highlight.watch(request => seen.highlight.push(request.issueKey)),
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
	}).not.toThrow();
	// Told of a change after the watches above, which began first.
	let told = 0;
	stops.push(onStateDbChange(dbPath, () => told++));

	fs.rmSync(dbPath);
	// Requests already in the database a watch comes to read were made for
	// an earlier TUI, as they are when a watch begins over a readable one.
	await daos.highlight.request({issueKey: 'STA-1', focus: false});
	await daos.companionRequests.send({
		id: 'request-0',
		space: 'STA-1',
		kind: 'width',
	});
	await until(() => told > 0, {
		what: 'the watches to read what was written while they could not',
	});

	await daos.highlight.request({issueKey: 'STA-2', focus: false});
	await daos.companionRequests.send({
		id: 'request-1',
		space: 'STA-2',
		kind: 'width',
	});
	await until(() => seen.highlight.length > 0 && seen.requests.length > 0, {
		what: 'a change made after the watches could read',
	});
	expect(seen).toStrictEqual({
		highlight: ['STA-2'],
		requests: ['request-1'],
	});
});
