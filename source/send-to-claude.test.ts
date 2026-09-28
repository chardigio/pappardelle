import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {LatestTask} from './latest-task.ts';
import {sendToSelectedClaude} from './send-to-claude.ts';

test('a send waits for the running attachment and reaches the new workspace', async t => {
	const queue = new LatestTask();
	let viewing = 'STA-1';
	const sentWhileViewing: string[] = [];
	const attach = queue.run(async () => {
		await delay(30);
		viewing = 'STA-2';
	});
	const result = await sendToSelectedClaude({
		queue,
		targetSpace: 'STA-2',
		viewingSpace: () => viewing,
		send() {
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
	const result = await sendToSelectedClaude({
		queue,
		targetSpace: 'STA-2',
		viewingSpace: () => 'STA-1',
		send() {
			sent = true;
			return true;
		},
	});
	t.is(result, 'wrong-space');
	t.false(sent);
});

test('a failed send is reported as failed', async t => {
	const result = await sendToSelectedClaude({
		queue: new LatestTask(),
		targetSpace: 'STA-2',
		viewingSpace: () => 'STA-2',
		send: () => false,
	});
	t.is(result, 'failed');
});
