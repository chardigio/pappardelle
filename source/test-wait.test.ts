import {expect, test} from 'bun:test';
import {until, untilValue} from '../test/helpers/wait.ts';

async function failure(waited: Promise<unknown>): Promise<string> {
	try {
		await waited;
	} catch (error) {
		return (error as Error).message;
	}

	throw new Error('the wait did not time out');
}

test('untilValue returns the value accept held for', async () => {
	let reads = 0;
	const value = await untilValue(
		() => ++reads,
		count => count >= 3,
	);
	expect(value).toBe(3);
});

test('a timeout names what it waited for and prints the frame', async () => {
	const message = await failure(
		until(() => false, {
			what: 'the popup to close',
			frame: () => 'last frame',
			timeoutMs: 20,
		}),
	);
	expect(message).toBe('Timed out waiting for the popup to close\nlast frame');
});

test('untilValue without a frame prints the last value it read', async () => {
	const message = await failure(
		untilValue(
			() => ({status: 'working'}),
			info => info.status === 'done',
			{timeoutMs: 20},
		),
	);
	expect(message).toBe(
		'Timed out waiting for the condition\nlast value: {\n  status: "working",\n}',
	);
});
