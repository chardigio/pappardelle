// Logging system for Pappardelle
import {Buffer} from 'node:buffer';
import {
	existsSync,
	mkdirSync,
	appendFileSync,
	readdirSync,
	unlinkSync,
	statSync,
} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

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

// In-memory error buffer for TUI display
const recentErrors: LogEntry[] = [];
let errorListeners: Array<(errors: LogEntry[]) => void> = [];

function ensureLogDir(): void {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, {recursive: true});
	}
}

function getLogFileName(): string {
	const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	return `pappardelle-${date}.log`;
}

function getLogFilePath(): string {
	return path.join(LOG_DIR, getLogFileName());
}

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

function rotateLogsIfNeeded(): void {
	try {
		ensureLogDir();
		const files = readdirSync(LOG_DIR)
			.filter(f => f.startsWith('pappardelle-') && f.endsWith('.log'))
			.map(f => ({
				name: f,
				path: path.join(LOG_DIR, f),
				mtime: statSync(path.join(LOG_DIR, f)).mtime.getTime(),
			}))
			.sort((a, b) => b.mtime - a.mtime); // Newest first

		// Remove old log files
		for (const file of files.slice(MAX_LOG_FILES)) {
			try {
				unlinkSync(file.path);
			} catch {
				// Ignore deletion errors
			}
		}
	} catch {
		// Ignore rotation errors
	}
}

function writeToFile(entry: LogEntry): void {
	try {
		ensureLogDir();
		rotateLogsIfNeeded();
		const line = formatLogEntry(entry) + '\n';
		appendFileSync(getLogFilePath(), line, 'utf-8');
	} catch {
		// Silently fail - we don't want logging to break the app
	}
}

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

	writeToFile(entry);

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

// Get log directory path (for user reference)
export function getLogDir(): string {
	return LOG_DIR;
}

// Intercept stderr writes so Ink/React rendering errors land in the log file.
// Call once at startup (idempotent).
let stderrCaptured = false;

/* eslint-disable no-control-regex */
// Strip all ANSI escape sequences from a string
const ANSI_RE =
	/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~lh]/g;
/* eslint-enable no-control-regex */

function isStderrNoise(text: string): boolean {
	return text.replace(ANSI_RE, '').trim() === '';
}

export function captureStderr(): void {
	if (stderrCaptured) return;
	stderrCaptured = true;

	const originalWrite = process.stderr.write.bind(process.stderr);
	const stderrLog = createLogger('stderr');

	process.stderr.write = (
		chunk: Uint8Array | string,
		encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
		cb?: (err?: Error | null) => void,
	): boolean => {
		const text =
			typeof chunk === 'string'
				? chunk.trim()
				: Buffer.from(chunk).toString('utf-8').trim();
		if (text && !isStderrNoise(text)) {
			stderrLog.error(text);
		}
		return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
	};
}

// Export a default logger for general use
export const logger = createLogger('app');
