import test from 'ava';
import {mock} from 'node:test';
import React from 'react';
import {render} from 'ink-testing-library';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {useRailStatusPolling} from './use-rail-status-polling.ts';

function Harness(props: {isEnabled: boolean; poll: () => Promise<void>}) {
	useRailStatusPolling(props.isEnabled, props.poll);
	return null;
}

test.serial(
	'polls on readiness, retains cadence across renders, and cleans up',
	async t => {
		const intervals: Array<{tick: () => Promise<void>; delay: number}> = [];
		const timer = {ref() {}, unref() {}};
		mock.method(globalThis, 'setInterval', (tick, delay) => {
			intervals.push({tick, delay});
			return timer;
		});
		const clear = mock.method(globalThis, 'clearInterval', () => {});
		t.teardown(() => mock.restoreAll());
		let calls = 0;
		const poll = async () => {
			calls++;
		};
		const view = render(React.createElement(Harness, {isEnabled: false, poll}));
		t.teardown(() => view.unmount());
		await nextTurn();
		t.is(calls, 0);
		t.is(intervals.length, 0);

		view.rerender(React.createElement(Harness, {isEnabled: true, poll}));
		await nextTurn();
		t.is(calls, 1, 'workspaces becoming ready triggers an immediate request');
		t.is(intervals.length, 1);
		t.is(intervals[0]!.delay, 60_000);

		let latestCalls = 0;
		let finish: (() => void) | undefined;
		const latestPoll = async () => {
			latestCalls++;
			await new Promise<void>(resolve => {
				finish = resolve;
			});
		};
		view.rerender(
			React.createElement(Harness, {isEnabled: true, poll: latestPoll}),
		);
		await nextTurn();
		t.is(latestCalls, 0, 'ordinary renders do not trigger more requests');
		t.is(intervals.length, 1, 'ordinary renders do not reset the interval');
		const pending = intervals[0]!.tick();
		t.is(latestCalls, 1, 'scheduled polls use the latest callback');
		await intervals[0]!.tick();
		t.is(latestCalls, 1, 'slow requests cannot overlap');
		finish!();
		await pending;

		view.rerender(React.createElement(Harness, {isEnabled: false, poll}));
		await nextTurn();
		t.is(clear.mock.callCount(), 1);
		view.rerender(React.createElement(Harness, {isEnabled: true, poll}));
		await nextTurn();
		t.is(calls, 2, 'polling resumes immediately when targets return');
		view.unmount();
		await nextTurn();
		t.is(clear.mock.callCount(), 2);
	},
);
