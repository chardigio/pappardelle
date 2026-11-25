import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {mock} from 'node:test';
import React from 'react';
import {render} from '../test/helpers/render.ts';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {useRailStatusPolling} from './use-rail-status-polling.ts';

function Harness(props: {isEnabled: boolean; poll: () => Promise<void>}) {
	useRailStatusPolling(props.isEnabled, props.poll);
	return null;
}

test('polls on readiness, retains cadence across renders, and cleans up', async () => {
	const intervals: Array<{tick: () => Promise<void>; delay: number}> = [];
	const timer = {ref() {}, unref() {}};
	mock.method(globalThis, 'setInterval', (tick, delay) => {
		intervals.push({tick, delay});
		return timer;
	});
	const clear = mock.method(globalThis, 'clearInterval', () => {});
	teardown(() => mock.restoreAll());
	let calls = 0;
	const poll = async () => {
		calls++;
	};
	const view = await render(
		React.createElement(Harness, {isEnabled: false, poll}),
	);
	teardown(async () => {
		await view.unmount();
	});
	await nextTurn();
	expect(calls).toBe(0);
	expect(intervals.length).toBe(0);

	await view.rerender(React.createElement(Harness, {isEnabled: true, poll}));
	await nextTurn();
	expect(calls, 'workspaces becoming ready triggers an immediate request').toBe(
		1,
	);
	expect(intervals.length).toBe(1);
	expect(intervals[0]!.delay).toBe(60_000);

	let latestCalls = 0;
	let finish: (() => void) | undefined;
	const latestPoll = async () => {
		latestCalls++;
		await new Promise<void>(resolve => {
			finish = resolve;
		});
	};
	await view.rerender(
		React.createElement(Harness, {isEnabled: true, poll: latestPoll}),
	);
	await nextTurn();
	expect(latestCalls, 'ordinary renders do not trigger more requests').toBe(0);
	expect(intervals.length, 'ordinary renders do not reset the interval').toBe(
		1,
	);
	const pending = intervals[0]!.tick();
	expect(latestCalls, 'scheduled polls use the latest callback').toBe(1);
	await intervals[0]!.tick();
	expect(latestCalls, 'slow requests cannot overlap').toBe(1);
	finish!();
	await pending;

	await view.rerender(React.createElement(Harness, {isEnabled: false, poll}));
	await nextTurn();
	expect(clear.mock.callCount()).toBe(1);
	await view.rerender(React.createElement(Harness, {isEnabled: true, poll}));
	await nextTurn();
	expect(calls, 'polling resumes immediately when targets return').toBe(2);
	await view.unmount();
	await nextTurn();
	expect(clear.mock.callCount()).toBe(2);
});
