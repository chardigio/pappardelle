import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {createAnimationClock} from './animation-clock.ts';

test('staggered subscribers share frames and the clock stops when the last row unmounts', async t => {
	const clock = createAnimationClock(20);
	const frames: number[][] = [[], []];
	const stopFirst = clock.subscribe(() => frames[0]!.push(clock.getSnapshot()));
	t.teardown(stopFirst);
	await delay(30);
	const stopSecond = clock.subscribe(() =>
		frames[1]!.push(clock.getSnapshot()),
	);
	t.teardown(stopSecond);
	await delay(60);
	t.true(frames[1]!.length > 0);
	t.deepEqual(frames[0]!.slice(-frames[1]!.length), frames[1]);
	stopFirst();
	const firstCount = frames[0]!.length;
	await delay(30);
	t.is(frames[0]!.length, firstCount);
	stopSecond();
	const secondCount = frames[1]!.length;
	await delay(30);
	t.is(frames[1]!.length, secondCount);
	t.is(clock.getSnapshot(), 0);
	const stopRestarted = clock.subscribe(() => {});
	t.teardown(stopRestarted);
	await delay(30);
	t.true(clock.getSnapshot() > 0);
});
