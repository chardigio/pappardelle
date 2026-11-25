import {setImmediate as nextTurn} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {unreachable} from '../test/helpers/unreachable.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {WorkspaceCloseTasks} from './workspace-close.ts';

test('manual, automatic, and bulk requests share one close, while other workspaces can close', async () => {
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
		unreachable('duplicate deinit');
		return false;
	});
	expect(await tasks.run('B', async () => true)).toBe(true);
	await nextTurn();
	expect(calls).toBe(1);
	finish(false);
	expect(await first).toBe(false);
	expect(await duplicate).toBe(false);
	expect(await tasks.run('A', async () => true)).toBe(true);
});

test('a rejected close can be retried', async () => {
	const tasks = new WorkspaceCloseTasks();
	await rejectionOf(
		tasks.run('A', async () => {
			throw new Error('failed');
		}),
	);
	expect(await tasks.run('A', async () => true)).toBe(true);
});

test('a close is running from when it is asked for until it has returned or thrown', async () => {
	const tasks = new WorkspaceCloseTasks();
	let finish = (_result: boolean) => {};
	const close = tasks.run(
		'A',
		async () =>
			new Promise<boolean>(resolve => {
				finish = resolve;
			}),
	);
	expect(tasks.has('A')).toBe(true);
	expect(tasks.has('B')).toBe(false);
	await nextTurn();
	expect(tasks.has('A')).toBe(true);
	finish(true);
	await close;
	expect(tasks.has('A')).toBe(false);

	const failing = tasks.run('A', async () => {
		throw new Error('failed');
	});
	expect(tasks.has('A')).toBe(true);
	await rejectionOf(failing);
	expect(tasks.has('A')).toBe(false);
});
