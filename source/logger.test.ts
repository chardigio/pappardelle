import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {
	closeSync,
	constants,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	createLogSink,
	type LogEntry,
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

// ============================================================================
// Log file sink
// ============================================================================

function makeLogDir(): string {
	return mkdtempSync(path.join(tmpdir(), 'pappardelle-logs-'));
}

function entry(message: string, date = '2026-10-05'): LogEntry {
	return {
		timestamp: `${date}T12:00:00.000Z`,
		level: 'info',
		component: 'test',
		message,
	};
}

function readLogLines(dir: string, date = '2026-10-05'): string[] {
	return readFileSync(path.join(dir, `pappardelle-${date}.log`), 'utf8')
		.split('\n')
		.filter(Boolean);
}

function messages(lines: string[]): string[] {
	return lines.map(line => line.replace(/^.*?\[test\] /, ''));
}

test('log sink keeps the event loop free while storage is stalled', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	// A FIFO nobody reads stands in for stalled storage: once its kernel buffer
	// fills, every write to it blocks until the reader drains it.
	const fifo = path.join(dir, 'pappardelle-2026-10-05.log');
	execFileSync('mkfifo', [fifo]);
	// eslint-disable-next-line no-bitwise
	const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
	t.teardown(() => {
		closeSync(reader);
	});
	const sink = createLogSink({dir});
	const expected = Array.from(
		{length: 300},
		(_, i) => `line ${i} ${'x'.repeat(1000)}`,
	);

	for (const message of expected) sink.write(entry(message));
	let settled = false;
	const settling = sink.settle().then(() => {
		settled = true;
	});
	await delay(50);
	t.false(settled);

	const chunks: Buffer[] = [];
	const chunk = Buffer.alloc(64 * 1024);
	const drain = () => {
		for (;;) {
			try {
				const n = readSync(reader, chunk);
				if (n === 0) return;
				chunks.push(Buffer.from(chunk.subarray(0, n)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return;
				throw error;
			}
		}
	};

	const draining = setInterval(drain, 5);
	await settling;
	clearInterval(draining);
	drain();
	t.deepEqual(
		messages(
			Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean),
		),
		expected,
	);
});

test('log sink keeps lines in order across batched writes', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});
	const expected = Array.from({length: 2000}, (_, i) => `line ${i}`);

	for (const message of expected) sink.write(entry(message));
	await sink.settle();

	t.deepEqual(messages(readLogLines(dir)), expected);
});

test('log sink drops lines past the queue cap and records how many', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir, maxQueuedBytes: 200});

	for (let i = 0; i < 50; i++) sink.write(entry(`line ${i}`));
	await sink.settle();

	const lines = readLogLines(dir);
	const marker = lines.at(-1)!;
	const dropped = Number(
		/\[logger\] dropped (\d+) messages$/.exec(marker)?.[1],
	);
	const written = messages(lines.slice(0, -1));
	t.true(dropped > 0);
	t.deepEqual(
		written,
		Array.from({length: written.length}, (_, i) => `line ${i}`),
	);
	t.is(written.length + dropped, 50);
});

test('log sink writes each entry to the file for its own date', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});

	sink.write(entry('before midnight 1', '2026-10-05'));
	sink.write(entry('before midnight 2', '2026-10-05'));
	sink.write(entry('after midnight 1', '2026-10-06'));
	sink.write(entry('after midnight 2', '2026-10-06'));
	await sink.settle();

	t.deepEqual(messages(readLogLines(dir, '2026-10-05')), [
		'before midnight 1',
		'before midnight 2',
	]);
	t.deepEqual(messages(readLogLines(dir, '2026-10-06')), [
		'after midnight 1',
		'after midnight 2',
	]);
});

test('log sink flushSync writes queued lines before returning', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});

	// The first write is dispatched to the threadpool immediately; the rest
	// queue behind it and are what an exit-time flush must persist.
	for (let i = 0; i < 5; i++) sink.write(entry(`line ${i}`));
	sink.flushSync();

	const flushed = messages(readLogLines(dir)).filter(m => m !== 'line 0');
	t.deepEqual(flushed, ['line 1', 'line 2', 'line 3', 'line 4']);

	// Line 0 may land after the flushed lines; it must still appear exactly once.
	await sink.settle();
	const final = messages(readLogLines(dir));
	t.is(final.filter(m => m === 'line 0').length, 1);
	t.deepEqual(
		final.filter(m => m !== 'line 0'),
		['line 1', 'line 2', 'line 3', 'line 4'],
	);
});

test('log sink survives a failed write and retries it on the next write', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const fifo = path.join(dir, 'pappardelle-2026-10-05.log');
	execFileSync('mkfifo', [fifo]);
	// eslint-disable-next-line no-bitwise
	const nonBlockingRead = constants.O_RDONLY | constants.O_NONBLOCK;
	const firstReader = openSync(fifo, nonBlockingRead);
	const sink = createLogSink({dir});
	sink.write(entry('before outage'));
	await sink.settle();
	const chunk = Buffer.alloc(64 * 1024);
	readSync(firstReader, chunk);
	closeSync(firstReader);

	// With no reader left, the write fails with EPIPE.
	sink.write(entry('during outage'));
	await sink.settle();

	const reader = openSync(fifo, nonBlockingRead);
	t.teardown(() => {
		closeSync(reader);
	});
	sink.write(entry('after recovery'));
	await sink.settle();

	const n = readSync(reader, chunk);
	t.deepEqual(
		messages(chunk.subarray(0, n).toString('utf8').split('\n').filter(Boolean)),
		['during outage', 'after recovery'],
	);
});

test('log sink survives an unusable log dir and retries on the next date', async t => {
	const root = makeLogDir();
	t.teardown(() => {
		rmSync(root, {recursive: true, force: true});
	});
	const dir = path.join(root, 'logs');
	writeFileSync(dir, 'not a directory');
	const sink = createLogSink({dir});

	t.notThrows(() => {
		sink.write(entry('lost'));
	});
	t.notThrows(() => {
		sink.flushSync();
	});

	rmSync(dir);
	mkdirSync(dir);
	sink.write(entry('same date, not retried'));
	t.deepEqual(readdirSync(dir), []);

	sink.write(entry('next date', '2026-10-06'));
	await sink.settle();
	t.deepEqual(messages(readLogLines(dir, '2026-10-06')), ['next date']);
});

test('log sink prunes all but the newest seven log files', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const now = Date.now() / 1000;
	for (let day = 1; day <= 9; day++) {
		const file = path.join(dir, `pappardelle-2026-09-0${day}.log`);
		writeFileSync(file, '');
		const age = now - (10 - day) * 86_400;
		utimesSync(file, age, age);
	}

	const sink = createLogSink({dir});
	sink.write(entry('today'));
	await sink.settle();

	t.deepEqual(readdirSync(dir).sort(), [
		'pappardelle-2026-09-04.log',
		'pappardelle-2026-09-05.log',
		'pappardelle-2026-09-06.log',
		'pappardelle-2026-09-07.log',
		'pappardelle-2026-09-08.log',
		'pappardelle-2026-09-09.log',
		'pappardelle-2026-10-05.log',
	]);
});

test('log sink never prunes the file it has open', async t => {
	const dir = makeLogDir();
	t.teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const future = Date.now() / 1000 + 86_400;
	for (let day = 1; day <= 9; day++) {
		const file = path.join(dir, `pappardelle-2026-11-0${day}.log`);
		writeFileSync(file, '');
		utimesSync(file, future + day, future + day);
	}

	const sink = createLogSink({dir});
	sink.write(entry('today'));
	await sink.settle();

	const remaining = readdirSync(dir).sort();
	t.is(remaining.length, 7);
	t.true(remaining.includes('pappardelle-2026-10-05.log'));
	t.deepEqual(messages(readLogLines(dir)), ['today']);
});
