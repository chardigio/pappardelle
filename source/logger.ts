// Logging system for Pappardelle
import {Buffer} from 'node:buffer';
import {mkdirSync, openSync} from 'node:fs';
import {readdir, stat, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import sonicBoom from 'sonic-boom';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	component: string;
	message: string;
	error?: string;
}

// Log directory: ~/.pappardelle/logs/
const LOG_DIR = path.join(homedir(), '.pappardelle', 'logs');
const MAX_LOG_FILES = 7; // Keep last 7 days of logs
const MAX_RECENT_ERRORS = 10; // Keep last 10 errors in memory for TUI display
const ERROR_TTL_MS = 5 * 60 * 1000; // Auto-clear errors from UI after 5 minutes
const MAX_QUEUED_LOG_BYTES = 1024 * 1024;

// sonic-boom is CommonJS; its types describe the default import as the module
// object, which carries the class as a property.
const {SonicBoom} = sonicBoom;

// In-memory error buffer for TUI display
const recentErrors: LogEntry[] = [];
let errorListeners: Array<(errors: LogEntry[]) => void> = [];

function formatLogEntry(entry: LogEntry): string {
	const parts = [
		entry.timestamp,
		`[${entry.level.toUpperCase().padEnd(5)}]`,
		`[${entry.component}]`,
		entry.message,
	];
	if (entry.error) {
		parts.push(`\n  Error: ${entry.error}`);
	}
	return parts.join(' ');
}

async function pruneOldLogs(dir: string): Promise<void> {
	try {
		const names = await readdir(dir);
		const files = await Promise.all(
			names
				.filter(f => f.startsWith('pappardelle-') && f.endsWith('.log'))
				.map(async name => {
					const filePath = path.join(dir, name);
					const {mtimeMs} = await stat(filePath);
					return {path: filePath, mtime: mtimeMs};
				}),
		);
		files.sort((a, b) => b.mtime - a.mtime); // Newest first

		await Promise.all(
			files.slice(MAX_LOG_FILES).map(async file => {
				try {
					await unlink(file.path);
				} catch {
					// Ignore deletion errors
				}
			}),
		);
	} catch {
		// Ignore rotation errors
	}
}

type LogStream = {
	boom: InstanceType<typeof SonicBoom>;
	idle: boolean;
	idleWaiters: Array<() => void>;
};

// Persists log entries without blocking Ink's event loop: sonic-boom keeps one
// async write in flight and batches whatever arrives meanwhile. The only sync
// filesystem calls are opening the day's file, once at startup and once per
// day after. Opening the fd ourselves means sonic-boom never has an async-open
// window during which flushSync() at exit would throw.
//
// Failures are never reported through stderr or the logger: captureStderr
// routes stderr back into the logger, which would loop.
export function createLogSink({
	dir,
	maxQueuedBytes = MAX_QUEUED_LOG_BYTES,
}: {
	dir: string;
	maxQueuedBytes?: number;
}) {
	const open = new Set<LogStream>();
	let current: LogStream | undefined;
	let currentDate: string | undefined;
	let dropped = 0;
	let prune: Promise<void> | undefined;

	function markIdle(stream: LogStream): void {
		stream.idle = true;
		for (const resolve of stream.idleWaiters.splice(0)) resolve();
	}

	function openStream(date: string): LogStream | undefined {
		let fd: number;
		try {
			mkdirSync(dir, {recursive: true});
			fd = openSync(path.join(dir, `pappardelle-${date}.log`), 'a');
		} catch {
			return undefined;
		}

		const boom = new SonicBoom({fd, minLength: 0, maxLength: maxQueuedBytes});
		const stream: LogStream = {boom, idle: true, idleWaiters: []};
		// Unhandled, an error event would crash the app. sonic-boom keeps the
		// failed buffer and retries it on the next write.
		boom.on('error', () => {});
		boom.on('drop', () => {
			dropped++;
		});
		boom.on('drain', () => {
			if (dropped > 0 && stream === current) {
				const message = `dropped ${dropped} messages`;
				dropped = 0;
				boom.write(
					formatLogEntry({
						timestamp: new Date().toISOString(),
						level: 'warn',
						component: 'logger',
						message,
					}) + '\n',
				);
				return;
			}

			markIdle(stream);
		});
		boom.on('close', () => {
			open.delete(stream);
			markIdle(stream);
		});
		open.add(stream);
		prune ??= pruneOldLogs(dir);
		return stream;
	}

	return {
		write(entry: LogEntry): void {
			const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
			if (date !== currentDate) {
				// A failed open isn't retried until the date changes, so a broken
				// log directory can't cost a sync open on every message.
				currentDate = date;
				current?.boom.end();
				current = openStream(date);
			}

			if (!current) return;
			current.idle = false;
			current.boom.write(formatLogEntry(entry) + '\n');
		},

		flushSync(): void {
			for (const stream of open) {
				try {
					stream.boom.flushSync();
				} catch {
					// Nothing more can be done at exit
				}
			}
		},

		// Resolves once pruning is done and every open stream has drained.
		async settle(): Promise<void> {
			await prune;
			await Promise.all(
				[...open].map(async stream => {
					if (stream.idle) return;
					await new Promise<void>(resolve => {
						stream.idleWaiters.push(resolve);
					});
				}),
			);
		},
	};
}

const sink = createLogSink({dir: LOG_DIR});
process.on('exit', () => {
	sink.flushSync();
});

function addToRecentErrors(entry: LogEntry): void {
	recentErrors.push(entry);
	if (recentErrors.length > MAX_RECENT_ERRORS) {
		recentErrors.shift();
	}
	// Notify listeners
	for (const listener of errorListeners) {
		listener([...recentErrors]);
	}
}

function log(
	level: LogLevel,
	component: string,
	message: string,
	error?: Error,
): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		component,
		message,
		error: error?.message,
	};

	sink.write(entry);

	// Add errors and warnings to recent errors for TUI display
	if (level === 'error' || level === 'warn') {
		addToRecentErrors(entry);
	}
}

// Create a logger for a specific component
export function createLogger(component: string) {
	return {
		debug: (message: string) => log('debug', component, message),
		info: (message: string) => log('info', component, message),
		warn: (message: string, error?: Error) =>
			log('warn', component, message, error),
		error: (message: string, error?: Error) =>
			log('error', component, message, error),
	};
}

// Subscribe to error updates for TUI display
export function subscribeToErrors(
	listener: (errors: LogEntry[]) => void,
): () => void {
	errorListeners.push(listener);
	// Immediately send current errors
	listener([...recentErrors]);
	// Return unsubscribe function
	return () => {
		errorListeners = errorListeners.filter(l => l !== listener);
	};
}

// Get current errors (for initial render)
export function getRecentErrors(): LogEntry[] {
	return [...recentErrors];
}

// Clear recent errors (for user dismissal)
export function clearRecentErrors(): void {
	recentErrors.length = 0;
	for (const listener of errorListeners) {
		listener([]);
	}
}

// Prune errors older than ERROR_TTL_MS from the in-memory buffer.
// Errors remain in log files — this only affects the TUI display.
// Accepts an optional `now` timestamp (ms) for testing; defaults to Date.now().
export function pruneExpiredErrors(now = Date.now()): void {
	const cutoff = now - ERROR_TTL_MS;
	const before = recentErrors.length;
	for (let i = recentErrors.length - 1; i >= 0; i--) {
		if (new Date(recentErrors[i]!.timestamp).getTime() <= cutoff) {
			recentErrors.splice(i, 1);
		}
	}

	if (recentErrors.length !== before) {
		for (const listener of errorListeners) {
			listener([...recentErrors]);
		}
	}
}

// Start the auto-prune timer. Check every 30 seconds.
// Uses unref() so the timer doesn't prevent process exit.
const pruneTimer = setInterval(pruneExpiredErrors, 30_000);
pruneTimer.unref();

// Get log directory path (for user reference)
export function getLogDir(): string {
	return LOG_DIR;
}

// Intercept stderr writes so Ink/React rendering errors land in the log file.
// Call once at startup (idempotent).
let stderrCaptured = false;

// Whether intercepted stderr is also forwarded to the real terminal.
//
// While the TUI owns the alternate screen, it must NOT be: a stray stderr write
// — e.g. a `gh`/`git` subprocess whose stderr we inherit printing "no git
// remotes found" — lands mid-frame inside Ink's managed alt-screen output and
// shifts every subsequent line down a row, leaving a ghost (the reported
// symptom was a duplicated top status-header line in QA screenshots, STA-1496).
// The bytes are still logged to the file and surfaced in the in-app error
// overlay, so suppressing the terminal copy loses nothing while the TUI is up.
//
// Defaults to "forward" so diagnostics print normally before the TUI mounts and
// after it tears down. cli.tsx flips it off when it enters the alt screen and
// back on during teardown (see setStderrTerminalPassthrough call sites).
let stderrTerminalPassthrough = true;

export function setStderrTerminalPassthrough(enabled: boolean): void {
	stderrTerminalPassthrough = enabled;
}

export function getStderrTerminalPassthrough(): boolean {
	return stderrTerminalPassthrough;
}

type StderrWrite = (
	chunk: Uint8Array | string,
	encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
	cb?: (err?: Error | null) => void,
) => boolean;

/* eslint-disable no-control-regex */
// Strip all ANSI escape sequences from a string
const ANSI_RE =
	/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~lh]/g;
/* eslint-enable no-control-regex */

function isStderrNoise(text: string): boolean {
	return text.replace(ANSI_RE, '').trim() === '';
}

// Build the replacement for process.stderr.write. Extracted (and exported) so
// the passthrough/suppression behavior is unit-testable without mutating the
// real process.stderr. Meaningful stderr is always mirrored to `logError`; the
// raw bytes are forwarded to `originalWrite` (the terminal) only when
// `shouldPassthrough()` is true.
export function makeStderrInterceptor(
	originalWrite: StderrWrite,
	logError: (text: string) => void,
	shouldPassthrough: () => boolean,
): StderrWrite {
	return (chunk, encodingOrCb, cb) => {
		const text =
			typeof chunk === 'string'
				? chunk.trim()
				: Buffer.from(chunk).toString('utf-8').trim();
		if (text && !isStderrNoise(text)) {
			logError(text);
		}

		if (!shouldPassthrough()) {
			// Swallow the terminal write but honor the stream contract: invoke any
			// completion callback so awaiting writers don't hang, and report success.
			const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
			callback?.();
			return true;
		}

		return originalWrite(chunk, encodingOrCb, cb);
	};
}

export function captureStderr(): void {
	if (stderrCaptured) return;
	stderrCaptured = true;

	const originalWrite = process.stderr.write.bind(
		process.stderr,
	) as StderrWrite;
	const stderrLog = createLogger('stderr');

	process.stderr.write = makeStderrInterceptor(
		originalWrite,
		text => {
			stderrLog.error(text);
		},
		() => stderrTerminalPassthrough,
	) as typeof process.stderr.write;
}

// Export a default logger for general use
export const logger = createLogger('app');
