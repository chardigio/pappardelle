import {Buffer} from 'node:buffer';
import test from 'ava';
import {
	createLogger,
	pruneExpiredErrors,
	getRecentErrors,
	clearRecentErrors,
	subscribeToErrors,
	makeStderrInterceptor,
	setStderrTerminalPassthrough,
	getStderrTerminalPassthrough,
} from './logger.ts';

const log = createLogger('test');

test.beforeEach(() => {
	clearRecentErrors();
});

// ============================================================================
// Pruning Tests
// ============================================================================

test.serial('pruneExpiredErrors removes all errors when time passes', t => {
	log.error('transient failure');
	log.error('another failure');
	t.is(getRecentErrors().length, 2);

	// Simulate 6 minutes passing
	pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});

test.serial('pruneExpiredErrors keeps errors younger than 5 minutes', t => {
	log.error('recent error 1');
	log.error('recent error 2');
	log.error('recent error 3');

	// Simulate only 3 minutes passing — all still fresh
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);
	t.is(getRecentErrors().length, 3);
});

test.serial('pruneExpiredErrors is a no-op on empty buffer', t => {
	pruneExpiredErrors(Date.now() + 10 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});

test.serial(
	'pruneExpiredErrors notifies listeners when errors are removed',
	t => {
		let notifiedCount = 0;
		const unsubscribe = subscribeToErrors(() => {
			notifiedCount++;
		});

		const baseline = notifiedCount; // subscription fires immediately

		log.error('will be pruned');
		t.is(notifiedCount, baseline + 1);

		pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
		t.is(notifiedCount, baseline + 2); // notified on prune
		t.is(getRecentErrors().length, 0);

		unsubscribe();
	},
);

test.serial('pruneExpiredErrors does not notify if nothing was pruned', t => {
	let notifyCount = 0;
	const unsubscribe = subscribeToErrors(() => {
		notifyCount++;
	});

	const baseline = notifyCount;

	log.error('fresh error');
	// Only 3 minutes — nothing to prune
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);

	// Notified once for the add, but not for the no-op prune
	t.is(notifyCount, baseline + 1);

	unsubscribe();
});

test.serial('pruneExpiredErrors prunes at exactly 5 minutes', t => {
	log.error('boundary error');

	// Exactly 5 minutes later — should be pruned (cutoff uses <=)
	pruneExpiredErrors(Date.now() + 5 * 60 * 1000);
	t.is(getRecentErrors().length, 0);
});

// ============================================================================
// stderr interceptor / terminal passthrough (STA-1496)
//
// While the TUI owns the alternate screen, stray stderr bytes (e.g. a failing
// `gh`/`git` subprocess whose stderr we inherit) must NOT reach the terminal —
// they land mid-frame inside Ink's managed output and shift it down a row,
// leaving a ghost (a duplicated top status-header line was the reported symptom).
// They must still be logged. These tests pin both halves of that contract.
// ============================================================================

type Captured = {written: string[]; logged: string[]};

function buildInterceptor(passthrough: () => boolean): {
	interceptor: ReturnType<typeof makeStderrInterceptor>;
	captured: Captured;
} {
	const captured: Captured = {written: [], logged: []};
	const interceptor = makeStderrInterceptor(
		(chunk: Uint8Array | string) => {
			captured.written.push(
				typeof chunk === 'string'
					? chunk
					: Buffer.from(chunk).toString('utf-8'),
			);
			return true;
		},
		text => captured.logged.push(text),
		passthrough,
	);
	return {interceptor, captured};
}

test.serial(
	'stderr interceptor forwards to the terminal when passthrough is enabled',
	t => {
		const {interceptor, captured} = buildInterceptor(() => true);
		const result = interceptor('boom\n');
		t.true(result);
		t.deepEqual(captured.written, ['boom\n']); // reached the terminal
		t.deepEqual(captured.logged, ['boom']); // and the log file
	},
);

test.serial(
	'stderr interceptor suppresses the terminal write while the TUI is active',
	t => {
		const {interceptor, captured} = buildInterceptor(() => false);
		const result = interceptor('no git remotes found\n');
		t.true(result); // honors the stream contract
		t.deepEqual(captured.written, []); // NOT forwarded → Ink frame untouched
		t.deepEqual(captured.logged, ['no git remotes found']); // still logged
	},
);

test.serial(
	'stderr interceptor invokes the completion callback even when suppressed',
	t => {
		const {interceptor} = buildInterceptor(() => false);
		let called = false;
		const result = interceptor('x\n', () => {
			called = true;
		});
		t.true(result);
		t.true(called); // awaiting writers must not hang
	},
);

test.serial(
	'stderr interceptor treats the callback-as-second-arg form when suppressed',
	t => {
		const {interceptor, captured} = buildInterceptor(() => false);
		let called = false;
		// Node's signature allows write(chunk, cb) with no encoding.
		const result = interceptor('y\n', () => {
			called = true;
		});
		t.true(result);
		t.true(called);
		t.deepEqual(captured.written, []);
	},
);

test.serial(
	'stderr interceptor skips pure-ANSI noise (logs nothing, forwards nothing) while suppressed',
	t => {
		const {interceptor, captured} = buildInterceptor(() => false);
		// '\x1b[?25h' is a pure ANSI control sequence (ESC + CSI ?25h,
		// cursor-show). isStderrNoise() classifies it as noise, so it is
		// neither logged nor forwarded. (Written with the readable \x1b escape
		// rather than a raw control byte so it survives diffs/formatters.)
		interceptor('\u001b[?25h');
		t.deepEqual(captured.logged, []);
		t.deepEqual(captured.written, []);

		// Contrast: text that merely looks like a CSI tail but lacks the leading
		// ESC is NOT noise — it must still be logged (just never forwarded).
		interceptor('[?25h not an escape');
		t.deepEqual(captured.logged, ['[?25h not an escape']);
		t.deepEqual(captured.written, []);
	},
);

test.serial(
	'setStderrTerminalPassthrough toggles whether the interceptor forwards',
	t => {
		const initial = getStderrTerminalPassthrough();
		try {
			const captured: Captured = {written: [], logged: []};
			const interceptor = makeStderrInterceptor(
				(chunk: Uint8Array | string) => {
					captured.written.push(String(chunk));
					return true;
				},
				text => captured.logged.push(text),
				getStderrTerminalPassthrough,
			);

			setStderrTerminalPassthrough(false);
			t.false(getStderrTerminalPassthrough());
			interceptor('suppressed\n');

			setStderrTerminalPassthrough(true);
			t.true(getStderrTerminalPassthrough());
			interceptor('forwarded\n');

			t.deepEqual(captured.written, ['forwarded\n']);
		} finally {
			setStderrTerminalPassthrough(initial);
		}
	},
);

test.serial('stderr terminal passthrough defaults to enabled', t => {
	// Default must be "forward" so diagnostics print normally before the TUI
	// mounts and after it tears down; cli.tsx only disables it while the alt
	// screen is owned.
	t.true(getStderrTerminalPassthrough());
});
