import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {WorkspaceCloseTasks} from './workspace-close.ts';

test('manual, automatic, and bulk requests share one close, while other workspaces can close', async t => {
	const tasks = new WorkspaceCloseTasks();
	let finish = (_result: boolean) => {};
	let calls = 0;
	const first = tasks.run('A', async () => {
		calls++;
		return new Promise<boolean>(resolve => {
			finish = resolve;
		});
	});
	const duplicate = tasks.run('A', async () => {
		t.fail('duplicate deinit');
		return false;
	});
	t.true(await tasks.run('B', async () => true));
	await nextTurn();
	t.is(calls, 1);
	finish(false);
	t.false(await first);
	t.false(await duplicate);
	t.true(await tasks.run('A', async () => true));
});

test('a rejected close can be retried', async t => {
	const tasks = new WorkspaceCloseTasks();
	await t.throwsAsync(
		tasks.run('A', async () => {
			throw new Error('failed');
		}),
	);
	t.true(await tasks.run('A', async () => true));
});
