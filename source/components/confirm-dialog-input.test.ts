import {test, expect} from 'bun:test';
import {press} from '../../test/helpers/key-press.ts';
import {
	parseConfirmDialogInput,
	isThenable,
	runConfirmSafely,
} from './confirm-dialog-input.ts';

const flushMicrotasks = async (): Promise<void> =>
	new Promise(resolve => {
		setImmediate(() => {
			resolve();
		});
	});

test('parseConfirmDialogInput: y confirms', () => {
	expect(parseConfirmDialogInput(press('y'), false)).toBe('confirm');
	expect(parseConfirmDialogInput(press('y', {shift: true}), false)).toBe(
		'confirm',
	);
});

test('parseConfirmDialogInput: Enter confirms', () => {
	expect(parseConfirmDialogInput(press('return'), false)).toBe('confirm');
});

test('parseConfirmDialogInput: n cancels', () => {
	expect(parseConfirmDialogInput(press('n'), false)).toBe('cancel');
	expect(parseConfirmDialogInput(press('n', {shift: true}), false)).toBe(
		'cancel',
	);
});

test('parseConfirmDialogInput: Escape cancels', () => {
	expect(parseConfirmDialogInput(press('escape'), false)).toBe('cancel');
});

test('parseConfirmDialogInput: unrelated keys are ignored', () => {
	expect(parseConfirmDialogInput(press('a'), false)).toBe('ignore');
	expect(parseConfirmDialogInput(press('space'), false)).toBe('ignore');
});

test('parseConfirmDialogInput: every input is ignored while processing', () => {
	// STA-1373: once the user has confirmed and the async deinit is running,
	// the dialog stays on screen showing "Closing space…" — any further key
	// (including a second Enter or an Esc/n) must be a no-op so we don't
	// accidentally fire a second cancel or stack up confirms.
	expect(parseConfirmDialogInput(press('y'), true)).toBe('ignore');
	expect(parseConfirmDialogInput(press('y', {shift: true}), true)).toBe(
		'ignore',
	);
	expect(parseConfirmDialogInput(press('n'), true)).toBe('ignore');
	expect(parseConfirmDialogInput(press('n', {shift: true}), true)).toBe(
		'ignore',
	);
	expect(parseConfirmDialogInput(press('return'), true)).toBe('ignore');
	expect(parseConfirmDialogInput(press('escape'), true)).toBe('ignore');
	expect(parseConfirmDialogInput(press('a'), true)).toBe('ignore');
});

test('isThenable: detects native Promise', () => {
	expect(isThenable(Promise.resolve())).toBe(true);
	expect(isThenable(new Promise(() => {}))).toBe(true);
});

test('isThenable: detects custom thenable', () => {
	// eslint-disable-next-line unicorn/no-thenable, object-shorthand
	const customThenable = {then: function () {}};
	expect(isThenable(customThenable)).toBe(true);
});

test('isThenable: rejects non-thenables', () => {
	expect(isThenable(undefined)).toBe(false);
	expect(isThenable(null)).toBe(false);
	expect(isThenable(42)).toBe(false);
	expect(isThenable('promise')).toBe(false);
	expect(isThenable({})).toBe(false);
	// eslint-disable-next-line unicorn/no-thenable
	const notThenable: Record<string, unknown> = {then: 'not a function'};
	expect(isThenable(notThenable)).toBe(false);
});

test('runConfirmSafely: returns sync void unchanged', () => {
	let called = false;
	const result = runConfirmSafely(() => {
		called = true;
	});
	expect(result).toBe(undefined);
	expect(called).toBe(true);
});

test('runConfirmSafely: returns the original promise', () => {
	const promise = Promise.resolve();
	const result = runConfirmSafely(async () => promise);
	expect(isThenable(result)).toBe(true);
});

test('runConfirmSafely: swallows a rejected promise without crashing the process', async () => {
	// STA-1373 / PR review: previously the dialog discarded onConfirm()'s
	// promise, so a rejection bubbled out as an unhandled rejection — Node
	// 15+ terminates on those. We attach a no-op rejection handler so the
	// rejection is absorbed even when the caller doesn't observe it.
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', onUnhandled);
	try {
		runConfirmSafely(async () => {
			throw new Error('boom');
		});
		await flushMicrotasks();
		await flushMicrotasks();
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}

	expect(unhandled).toStrictEqual([]);
});

test('runConfirmSafely: swallows a synchronous throw', () => {
	expect(() => {
		runConfirmSafely(() => {
			throw new Error('sync boom');
		});
	}).not.toThrow();
});
