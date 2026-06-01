import test from 'ava';
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

test('parseConfirmDialogInput: y confirms', t => {
	t.is(parseConfirmDialogInput('y', {}, false), 'confirm');
	t.is(parseConfirmDialogInput('Y', {}, false), 'confirm');
});

test('parseConfirmDialogInput: Enter confirms', t => {
	t.is(parseConfirmDialogInput('', {return: true}, false), 'confirm');
});

test('parseConfirmDialogInput: n cancels', t => {
	t.is(parseConfirmDialogInput('n', {}, false), 'cancel');
	t.is(parseConfirmDialogInput('N', {}, false), 'cancel');
});

test('parseConfirmDialogInput: Escape cancels', t => {
	t.is(parseConfirmDialogInput('', {escape: true}, false), 'cancel');
});

test('parseConfirmDialogInput: unrelated keys are ignored', t => {
	t.is(parseConfirmDialogInput('a', {}, false), 'ignore');
	t.is(parseConfirmDialogInput(' ', {}, false), 'ignore');
});

test('parseConfirmDialogInput: every input is ignored while processing', t => {
	// STA-1373: once the user has confirmed and the async deinit is running,
	// the dialog stays on screen showing "Closing space…" — any further key
	// (including a second Enter or an Esc/n) must be a no-op so we don't
	// accidentally fire a second cancel or stack up confirms.
	t.is(parseConfirmDialogInput('y', {}, true), 'ignore');
	t.is(parseConfirmDialogInput('Y', {}, true), 'ignore');
	t.is(parseConfirmDialogInput('n', {}, true), 'ignore');
	t.is(parseConfirmDialogInput('N', {}, true), 'ignore');
	t.is(parseConfirmDialogInput('', {return: true}, true), 'ignore');
	t.is(parseConfirmDialogInput('', {escape: true}, true), 'ignore');
	t.is(parseConfirmDialogInput('a', {}, true), 'ignore');
});

test('isThenable: detects native Promise', t => {
	t.true(isThenable(Promise.resolve()));
	t.true(isThenable(new Promise(() => {})));
});

test('isThenable: detects custom thenable', t => {
	// eslint-disable-next-line unicorn/no-thenable, object-shorthand
	const customThenable = {then: function () {}};
	t.true(isThenable(customThenable));
});

test('isThenable: rejects non-thenables', t => {
	t.false(isThenable(undefined));
	t.false(isThenable(null));
	t.false(isThenable(42));
	t.false(isThenable('promise'));
	t.false(isThenable({}));
	// eslint-disable-next-line unicorn/no-thenable
	const notThenable: Record<string, unknown> = {then: 'not a function'};
	t.false(isThenable(notThenable));
});

test('runConfirmSafely: returns sync void unchanged', t => {
	let called = false;
	const result = runConfirmSafely(() => {
		called = true;
	});
	t.is(result, undefined);
	t.true(called);
});

test('runConfirmSafely: returns the original promise', t => {
	const promise = Promise.resolve();
	const result = runConfirmSafely(async () => promise);
	t.true(isThenable(result));
});

test('runConfirmSafely: swallows a rejected promise without crashing the process', async t => {
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

	t.deepEqual(unhandled, []);
});

test('runConfirmSafely: swallows a synchronous throw', t => {
	t.notThrows(() => {
		runConfirmSafely(() => {
			throw new Error('sync boom');
		});
	});
});
