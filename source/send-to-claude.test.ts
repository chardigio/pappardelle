import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {LatestTask} from './latest-task.ts';
import {sendToSelectedAgent} from './send-to-claude.ts';

test('a send waits for the running attachment and reaches the new workspace', async t => {
	const queue = new LatestTask();
	let viewing = 'STA-1';
	const sentWhileViewing: string[] = [];
	const attach = queue.run(async () => {
		await delay(30);
		viewing = 'STA-2';
	});
	const result = await sendToSelectedAgent({
		queue,
		sends: new LatestTask(),
		targetSpace: 'STA-2',
		viewingSpace: () => viewing,
		async send() {
			sentWhileViewing.push(viewing);
			return true;
		},
	});
	await attach;
	t.is(result, 'sent');
	t.deepEqual(sentWhileViewing, ['STA-2']);
});

test('a send is dropped when the viewer shows a different workspace', async t => {
	const queue = new LatestTask();
	let sent = false;
	const result = await sendToSelectedAgent({
		queue,
		sends: new LatestTask(),
		targetSpace: 'STA-2',
		viewingSpace: () => 'STA-1',
		async send() {
			sent = true;
			return true;
		},
	});
	t.is(result, 'wrong-space');
	t.false(sent);
});

test('a failed send is reported as failed', async t => {
	const result = await sendToSelectedAgent({
		queue: new LatestTask(),
		sends: new LatestTask(),
		targetSpace: 'STA-2',
		viewingSpace: () => 'STA-2',
		send: () => false,
	});
	t.is(result, 'failed');
});

test('a send waiting on another sender does not hold up attachment', async t => {
	const queue = new LatestTask();
	let releaseSend!: () => void;
	const sending = sendToSelectedAgent({
		queue,
		sends: new LatestTask(),
		targetSpace: 'STA-1',
		viewingSpace: () => 'STA-1',
		send: async () =>
			new Promise<boolean>(resolve => {
				releaseSend = () => {
					resolve(true);
				};
			}),
	});
	let attached = false;
	await queue.run(async () => {
		attached = true;
	});
	t.true(attached);
	releaseSend();
	t.is(await sending, 'sent');
});

test('sends reach the agent in the order the keys were pressed', async t => {
	const queue = new LatestTask();
	const sends = new LatestTask();
	const received: string[] = [];
	const sendAfter = (text: string, ms: number) =>
		sendToSelectedAgent({
			queue,
			sends,
			targetSpace: 'STA-1',
			viewingSpace: () => 'STA-1',
			async send() {
				await delay(ms);
				received.push(text);
				return true;
			},
		});
	await Promise.all([sendAfter('first', 30), sendAfter('second', 0)]);
	t.deepEqual(received, ['first', 'second']);
});
