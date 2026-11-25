import {Buffer} from 'node:buffer';
import {execFileSync, spawnSync} from 'node:child_process';
import {
	closeSync,
	constants,
	existsSync,
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
import {pathToFileURL} from 'node:url';
import {test, expect, beforeEach} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {
	createLogSink,
	type LogEntry,
	createLogger,
	pruneExpiredErrors,
	getRecentErrors,
	clearRecentErrors,
	subscribeToErrors,
	makeStderrInterceptor,
	makeConsoleError,
	setStderrTerminalPassthrough,
	getStderrTerminalPassthrough,
} from './logger.ts';

const log = createLogger('test');

beforeEach(() => {
	clearRecentErrors();
});

test('recent errors drop the color codes of script output', () => {
	log.error(
		'Failed: \u001B[0;36mSelect a project profile:\u001B[0m',
		new Error('\u001B[31mexit 1\u001B[0m'),
	);
	const [entry] = getRecentErrors();
	expect(entry?.message).toBe('Failed: Select a project profile:');
	expect(entry?.error).toBe('exit 1');
});

// ============================================================================
// Pruning Tests
// ============================================================================

test('pruneExpiredErrors removes all errors when time passes', () => {
	log.error('transient failure');
	log.error('another failure');
	expect(getRecentErrors().length).toBe(2);

	// Simulate 6 minutes passing
	pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
	expect(getRecentErrors().length).toBe(0);
});

test('pruneExpiredErrors keeps errors younger than 5 minutes', () => {
	log.error('recent error 1');
	log.error('recent error 2');
	log.error('recent error 3');

	// Simulate only 3 minutes passing — all still fresh
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);
	expect(getRecentErrors().length).toBe(3);
});

test('pruneExpiredErrors is a no-op on empty buffer', () => {
	pruneExpiredErrors(Date.now() + 10 * 60 * 1000);
	expect(getRecentErrors().length).toBe(0);
});

test('pruneExpiredErrors notifies listeners when errors are removed', () => {
	let notifiedCount = 0;
	const unsubscribe = subscribeToErrors(() => {
		notifiedCount++;
	});

	const baseline = notifiedCount; // subscription fires immediately

	log.error('will be pruned');
	expect(notifiedCount).toBe(baseline + 1);

	pruneExpiredErrors(Date.now() + 6 * 60 * 1000);
	expect(notifiedCount).toBe(baseline + 2); // notified on prune
	expect(getRecentErrors().length).toBe(0);

	unsubscribe();
});

test('pruneExpiredErrors does not notify if nothing was pruned', () => {
	let notifyCount = 0;
	const unsubscribe = subscribeToErrors(() => {
		notifyCount++;
	});

	const baseline = notifyCount;

	log.error('fresh error');
	// Only 3 minutes — nothing to prune
	pruneExpiredErrors(Date.now() + 3 * 60 * 1000);

	// Notified once for the add, but not for the no-op prune
	expect(notifyCount).toBe(baseline + 1);

	unsubscribe();
});

test('pruneExpiredErrors prunes at exactly 5 minutes', () => {
	log.error('boundary error');

	// Exactly 5 minutes later — should be pruned (cutoff uses <=)
	pruneExpiredErrors(Date.now() + 5 * 60 * 1000);
	expect(getRecentErrors().length).toBe(0);
});

// ============================================================================
// stderr interceptor / terminal passthrough (STA-1496)
//
// While the TUI owns the alternate screen, stray stderr bytes (e.g. a failing
// `gh`/`git` subprocess whose stderr we inherit) must NOT reach the terminal —
// they land mid-frame inside the renderer's output and shift it down a row,
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

test('stderr interceptor forwards to the terminal when passthrough is enabled', () => {
	const {interceptor, captured} = buildInterceptor(() => true);
	const result = interceptor('boom\n');
	expect(result).toBe(true);
	expect(captured.written).toStrictEqual(['boom\n']); // reached the terminal
	expect(captured.logged).toStrictEqual(['boom']); // and the log file
});

test('stderr interceptor suppresses the terminal write while the TUI is active', () => {
	const {interceptor, captured} = buildInterceptor(() => false);
	const result = interceptor('no git remotes found\n');
	expect(result).toBe(true); // honors the stream contract
	expect(captured.written).toStrictEqual([]); // NOT forwarded → frame untouched
	expect(captured.logged).toStrictEqual(['no git remotes found']); // still logged
});

test('stderr interceptor invokes the completion callback even when suppressed', () => {
	const {interceptor} = buildInterceptor(() => false);
	let called = false;
	const result = interceptor('x\n', () => {
		called = true;
	});
	expect(result).toBe(true);
	expect(called).toBe(true); // awaiting writers must not hang
});

test('stderr interceptor treats the callback-as-second-arg form when suppressed', () => {
	const {interceptor, captured} = buildInterceptor(() => false);
	let called = false;
	// Node's signature allows write(chunk, cb) with no encoding.
	const result = interceptor('y\n', () => {
		called = true;
	});
	expect(result).toBe(true);
	expect(called).toBe(true);
	expect(captured.written).toStrictEqual([]);
});

test('stderr interceptor skips pure-ANSI noise (logs nothing, forwards nothing) while suppressed', () => {
	const {interceptor, captured} = buildInterceptor(() => false);
	// '\x1b[?25h' is a pure ANSI control sequence (ESC + CSI ?25h,
	// cursor-show). isStderrNoise() classifies it as noise, so it is
	// neither logged nor forwarded. (Written with the readable \x1b escape
	// rather than a raw control byte so it survives diffs/formatters.)
	interceptor('\u001b[?25h');
	expect(captured.logged).toStrictEqual([]);
	expect(captured.written).toStrictEqual([]);

	// Contrast: text that merely looks like a CSI tail but lacks the leading
	// ESC is NOT noise — it must still be logged (just never forwarded).
	interceptor('[?25h not an escape');
	expect(captured.logged).toStrictEqual(['[?25h not an escape']);
	expect(captured.written).toStrictEqual([]);
});

test('setStderrTerminalPassthrough toggles whether the interceptor forwards', () => {
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
		expect(getStderrTerminalPassthrough()).toBe(false);
		interceptor('suppressed\n');

		setStderrTerminalPassthrough(true);
		expect(getStderrTerminalPassthrough()).toBe(true);
		interceptor('forwarded\n');

		expect(captured.written).toStrictEqual(['forwarded\n']);
	} finally {
		setStderrTerminalPassthrough(initial);
	}
});

test('stderr terminal passthrough defaults to enabled', () => {
	// Default must be "forward" so diagnostics print normally before the TUI
	// mounts and after it tears down; cli.tsx only disables it while the alt
	// screen is owned.
	expect(getStderrTerminalPassthrough()).toBe(true);
});

test('console.error reaches the log, except React reports of an error a boundary already caught', () => {
	const written: string[] = [];
	const consoleError = makeConsoleError(text => written.push(text));
	const failure = new Error('render failed');

	consoleError(failure, {componentStack: '\n    at Broken', errorBoundary: {}});
	expect(written).toStrictEqual([]);

	consoleError(
		'Warning: Each child in a list should have a unique "key" prop.',
	);
	consoleError(failure, {componentStack: '\n    at Broken'});
	expect(written.length).toBe(2);
	expect(written[0]!.includes('unique "key" prop')).toBe(true);
	expect(written[1]!.includes('render failed')).toBe(true);
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

test('log sink keeps the event loop free while storage is stalled', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	// A FIFO nobody reads stands in for stalled storage: once its kernel buffer
	// fills, every write to it blocks until the reader drains it.
	const fifo = path.join(dir, 'pappardelle-2026-10-05.log');
	execFileSync('mkfifo', [fifo]);
	// eslint-disable-next-line no-bitwise
	const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
	teardown(() => {
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
	expect(settled).toBe(false);

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
	expect(
		messages(
			Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean),
		),
	).toStrictEqual(expected);
});

test('log sink keeps lines in order across batched writes', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});
	const expected = Array.from({length: 2000}, (_, i) => `line ${i}`);

	for (const message of expected) sink.write(entry(message));
	await sink.settle();

	expect(messages(readLogLines(dir))).toStrictEqual(expected);
});

test('log sink drops lines past the queue cap and records how many', async () => {
	const dir = makeLogDir();
	teardown(() => {
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
	expect(dropped > 0).toBe(true);
	expect(written).toStrictEqual(
		Array.from({length: written.length}, (_, i) => `line ${i}`),
	);
	expect(written.length + dropped).toBe(50);
});

test('log sink writes each entry to the file for its own date', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});

	sink.write(entry('before midnight 1', '2026-10-05'));
	sink.write(entry('before midnight 2', '2026-10-05'));
	sink.write(entry('after midnight 1', '2026-10-06'));
	sink.write(entry('after midnight 2', '2026-10-06'));
	await sink.settle();

	expect(messages(readLogLines(dir, '2026-10-05'))).toStrictEqual([
		'before midnight 1',
		'before midnight 2',
	]);
	expect(messages(readLogLines(dir, '2026-10-06'))).toStrictEqual([
		'after midnight 1',
		'after midnight 2',
	]);
});

test('log sink keeps writing asynchronously after a flush that is not the exit flush', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});

	sink.write(entry('before flush'));
	sink.flushSync();
	sink.write(entry('after flush'));
	expect(messages(readLogLines(dir)).includes('after flush')).toBe(false);

	await sink.settle();
	expect(messages(readLogLines(dir)).includes('after flush')).toBe(true);
});

test('log sink flushSync writes queued lines before returning', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const sink = createLogSink({dir});

	// The first write is dispatched to the threadpool immediately; the rest
	// queue behind it and are what an exit-time flush must persist.
	for (let i = 0; i < 5; i++) sink.write(entry(`line ${i}`));
	sink.flushSync();

	const flushed = messages(readLogLines(dir)).filter(m => m !== 'line 0');
	expect(flushed).toStrictEqual(['line 1', 'line 2', 'line 3', 'line 4']);

	// Line 0 may land after the flushed lines; it must still appear exactly once.
	await sink.settle();
	const final = messages(readLogLines(dir));
	expect(final.filter(m => m === 'line 0').length).toBe(1);
	expect(final.filter(m => m !== 'line 0')).toStrictEqual([
		'line 1',
		'line 2',
		'line 3',
		'line 4',
	]);
});

test('log sink survives a failed write and retries it on the next write', async () => {
	const dir = makeLogDir();
	teardown(() => {
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
	teardown(() => {
		closeSync(reader);
	});
	sink.write(entry('after recovery'));
	await sink.settle();

	const n = readSync(reader, chunk);
	expect(
		messages(chunk.subarray(0, n).toString('utf8').split('\n').filter(Boolean)),
	).toStrictEqual(['during outage', 'after recovery']);
});

test('log sink drains a failed batch once storage recovers, even after the queue filled', async () => {
	const dir = makeLogDir();
	teardown(() => {
		rmSync(dir, {recursive: true, force: true});
	});
	const fifo = path.join(dir, 'pappardelle-2026-10-05.log');
	execFileSync('mkfifo', [fifo]);
	// eslint-disable-next-line no-bitwise
	const nonBlockingRead = constants.O_RDONLY | constants.O_NONBLOCK;
	const firstReader = openSync(fifo, nonBlockingRead);
	const retries: Array<() => void> = [];
	const sink = createLogSink({
		dir,
		maxQueuedBytes: 300,
		scheduleRetry(retry) {
			retries.push(retry);
		},
	});
	sink.write(entry('before outage'));
	await sink.settle();
	const chunk = Buffer.alloc(64 * 1024);
	readSync(firstReader, chunk);
	closeSync(firstReader);

	// With no reader left the write fails with EPIPE, and later lines fill the
	// queue, so no further write would retry the failed batch.
	sink.write(entry('during outage'));
	await sink.settle();
	for (let i = 0; i < 10; i++) sink.write(entry(`overflow ${i}`));
	await sink.settle();

	const reader = openSync(fifo, nonBlockingRead);
	teardown(() => {
		closeSync(reader);
	});
	expect(retries.length > 0).toBe(true);
	retries.shift()!();
	await sink.settle();

	const n = readSync(reader, chunk);
	const recovered = messages(
		chunk.subarray(0, n).toString('utf8').split('\n').filter(Boolean),
	);
	expect(recovered[0]).toBe('during outage');
	expect(recovered.some(line => /dropped \d+ messages/.test(line))).toBe(true);
});

test('log sink survives an unusable log dir and retries on the next date', async () => {
	const root = makeLogDir();
	teardown(() => {
		rmSync(root, {recursive: true, force: true});
	});
	const dir = path.join(root, 'logs');
	writeFileSync(dir, 'not a directory');
	const sink = createLogSink({dir});

	expect(() => {
		sink.write(entry('lost'));
	}).not.toThrow();
	expect(() => {
		sink.flushSync();
	}).not.toThrow();

	rmSync(dir);
	mkdirSync(dir);
	sink.write(entry('same date, not retried'));
	expect(readdirSync(dir)).toStrictEqual([]);

	sink.write(entry('next date', '2026-10-06'));
	await sink.settle();
	expect(messages(readLogLines(dir, '2026-10-06'))).toStrictEqual([
		'next date',
	]);
});

test('log sink prunes all but the newest seven log files', async () => {
	const dir = makeLogDir();
	teardown(() => {
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

	expect(readdirSync(dir).sort()).toStrictEqual([
		'pappardelle-2026-09-04.log',
		'pappardelle-2026-09-05.log',
		'pappardelle-2026-09-06.log',
		'pappardelle-2026-09-07.log',
		'pappardelle-2026-09-08.log',
		'pappardelle-2026-09-09.log',
		'pappardelle-2026-10-05.log',
	]);
});

test('log sink never prunes the file it has open', async () => {
	const dir = makeLogDir();
	teardown(() => {
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
	expect(remaining.length).toBe(7);
	expect(remaining.includes('pappardelle-2026-10-05.log')).toBe(true);
	expect(messages(readLogLines(dir))).toStrictEqual(['today']);
});

// ============================================================================
// Exit paths
// ============================================================================

function runChild(script: string) {
	const home = mkdtempSync(path.join(tmpdir(), 'pappardelle-home-'));
	teardown(() => {
		rmSync(home, {recursive: true, force: true});
	});
	const loggerUrl = pathToFileURL(path.resolve('source/logger.ts')).href;
	const child = spawnSync(
		process.execPath,
		[
			'-e',
			`const {createLogger, captureStderr} = await import(${JSON.stringify(loggerUrl)});
const log = createLogger('child');
${script}`,
		],
		{env: {...process.env, HOME: home}, encoding: 'utf8'},
	);
	const logDir = path.join(home, '.pappardelle', 'logs');
	const text = existsSync(logDir)
		? readdirSync(logDir)
				.map(file => readFileSync(path.join(logDir, file), 'utf8'))
				.join('')
		: '';
	return {
		status: child.status,
		signal: child.signal,
		stderr: child.stderr,
		text,
		lines: text.match(/\[child\] \S+/g) ?? [],
		crashes: text.match(/\[crash\] .*/g) ?? [],
	};
}

test('lines logged right before process.exit land in the file', () => {
	const {status, lines} =
		runChild(`for (let i = 0; i < 50; i++) log.info('line-' + i);
process.exit(3);`);
	expect(status).toBe(3);
	// line-0 is already in fs.write when the process exits, so it may land after
	// the flushed lines or not at all; everything queued behind it must land.
	expect(lines.filter(line => line !== '[child] line-0')).toStrictEqual(
		Array.from({length: 49}, (_, index) => `[child] line-${index + 1}`),
	);
	expect(lines.filter(line => line === '[child] line-0').length <= 1).toBe(
		true,
	);
});

test('a line logged right before an uncaught crash lands in the file', () => {
	const {status, lines} = runChild(`log.error('before-crash');
setTimeout(() => { throw new Error('boom'); }, 0);`);
	expect(status).not.toBe(0);
	expect(lines).toStrictEqual(['[child] before-crash']);
});

test('an uncaught top-level error lands in the log with its stack', () => {
	const {status, text, stderr, crashes} = runChild(`captureStderr();
function throwAtTopLevel() { throw new Error('top-level-boom'); }
throwAtTopLevel();`);
	expect(status).toBe(1);
	expect(stderr.includes('top-level-boom')).toBe(true);
	expect(crashes).toStrictEqual(['[crash] Error: top-level-boom']);
	expect(text).toMatch(
		/\[crash\] Error: top-level-boom\n\s+at throwAtTopLevel/,
	);
});

test('unhandled rejections land in the log and still crash the process', () => {
	// Pending work must not keep a process alive past an unhandled rejection.
	const {status, text, stderr, crashes} = runChild(`captureStderr();
setInterval(() => {}, 1000);
void Promise.reject(new Error('first-rejection'));
void Promise.reject(new Error('second-rejection'));
void Promise.reject();
void Promise.reject();
void Promise.reject(new Error('after-duplicates'));`);
	expect(status).toBe(1);
	expect(stderr.includes('first-rejection')).toBe(true);
	expect(crashes).toStrictEqual([
		'[crash] Error: first-rejection',
		'[crash] Error: second-rejection',
		'[crash] undefined',
		'[crash] undefined',
		'[crash] Error: after-duplicates',
	]);
	expect(text).toMatch(/\[crash\] Error: first-rejection\n\s+at /);
});

test('a rejection raised after startup still crashes the process', () => {
	for (const script of [
		`setTimeout(() => { void Promise.reject(new Error('late-boom')); }, 0);`,
		`async function main() { await Bun.sleep(1); throw new Error('late-boom'); }
void main();`,
	]) {
		const {status, stderr, crashes} = runChild(`captureStderr();\n${script}`);
		expect(status, script).toBe(1);
		expect(stderr.includes('late-boom'), script).toBe(true);
		expect(crashes, script).toStrictEqual(['[crash] Error: late-boom']);
	}
});

test("Bun's crash report is unchanged by crash logging", () => {
	for (const script of [
		`await Promise.resolve();
function throwAtTopLevel() { throw new Error('report-boom'); }
throwAtTopLevel();`,
		`setTimeout(() => { void Promise.reject(new Error('report-boom')); }, 0);`,
	]) {
		// Bun's report quotes the lines above the throw; keep the call out of it.
		const padding = '\n'.repeat(6);
		const plain = runChild(`${padding}${script}`);
		const logged = runChild(`captureStderr();${padding}${script}`);
		expect(logged.crashes, script).toStrictEqual([
			'[crash] Error: report-boom',
		]);
		expect(logged.stderr, script).toBe(plain.stderr);
	}
});

test('a crash in a later exit listener lands in the log', () => {
	const {status, crashes} = runChild(`captureStderr();
process.on('exit', () => { throw new Error('exit-boom'); });
throw new Error('first-boom');`);
	expect(status).toBe(1);
	expect(crashes).toStrictEqual([
		'[crash] Error: first-boom',
		'[crash] Error: exit-boom',
	]);
});

test('errors another listener handles are not logged as crashes', () => {
	const {status, crashes} = runChild(`process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
captureStderr();
setTimeout(() => { throw new Error('handled-throw'); }, 0);
void Promise.reject(new Error('handled-rejection'));`);
	expect(status).toBe(0);
	expect(crashes).toStrictEqual([]);
});

test('a line logged by a later exit handler still lands in the file', () => {
	const {lines} = runChild(`log.info('before-exit');
process.on('exit', () => {
	for (let i = 0; i < 500; i++) log.error('during-exit-' + i);
});`);
	expect(lines).toStrictEqual([
		'[child] before-exit',
		...Array.from({length: 500}, (_, index) => `[child] during-exit-${index}`),
	]);
});

test('lines buffered when a signal kills the process land in the file', () => {
	const {signal, lines} = runChild(`setInterval(() => {}, 1000);
for (let i = 0; i < 5000; i++) log.info('line-' + i + ' ' + 'x'.repeat(40));
process.kill(process.pid, 'SIGTERM');`);
	expect(signal).toBe('SIGTERM');
	expect(new Set(lines).size).toBe(5000);
});

test('a process that exits past the queue cap still records how many lines it dropped', () => {
	const {text} =
		runChild(`for (let i = 0; i < 100000; i++) log.info('line-' + i + ' ' + 'x'.repeat(60));
process.exit(0);`);
	const kept = text.match(/\[child\] line-/g)?.length ?? 0;
	const dropped = Number(/dropped (\d+) messages/.exec(text)?.[1]);
	expect(kept > 0).toBe(true);
	expect(kept + dropped).toBe(100000);
});
