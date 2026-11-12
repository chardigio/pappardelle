// Telling other processes that the state database changed.
//
// SQLite has no notification across processes. Every writer rewrites a bell
// file next to the database after it commits, and a watcher sees that through
// fs.watch, the way the status files were watched before they became rows.

import {Database, type Statement} from 'bun:sqlite';
import {mkdirSync, watch, writeFileSync, type FSWatcher} from 'node:fs';
import path from 'node:path';

// A watch can drop an event (a full inotify queue, a filesystem without
// events), so the database is also looked at on a slow timer.
const FALLBACK_POLL_MS = 2000;
// Status monitors can ring hundreds of times a second between them.
// Listeners run at most this often, on the first ring and after the last.
const MIN_CHECK_INTERVAL_MS = 5;

export function stateBellPath(dbPath: string): string {
	return `${dbPath}.bell`;
}

export function ringStateBell(dbPath: string): void {
	try {
		writeFileSync(stateBellPath(dbPath), `${Date.now()}\n`);
	} catch {
		// The slow poll still finds the change.
	}
}

type Watch = {
	listeners: Set<() => void>;
	close(): void;
};

type Source = {
	connection: Database;
	version: Statement<{data_version: number}, []>;
	seen: number;
};

const watches = new Map<string, Watch>();

function openSource(dbPath: string): Source | undefined {
	let connection: Database | undefined;
	try {
		// data_version only moves for commits made on other connections, so this
		// one is kept apart from the connection the process writes with.
		connection = new Database(dbPath, {readonly: true});
		const version = connection.query<{data_version: number}, []>(
			'PRAGMA data_version',
		);
		return {connection, version, seen: version.get()!.data_version};
	} catch {
		connection?.close();
		return undefined;
	}
}

function startWatch(dbPath: string): Watch {
	const listeners = new Set<() => void>();
	let source = openSource(dbPath);
	let checkedAt = 0;
	let trailing: ReturnType<typeof setTimeout> | undefined;

	const notify = () => {
		for (const listener of listeners) listener();
	};

	const check = () => {
		trailing = undefined;
		checkedAt = performance.now();
		if (!source) return;
		let current: number;
		try {
			current = source.version.get()!.data_version;
		} catch {
			// The file was replaced or damaged under this connection. The poll
			// opens it again when it can be read.
			source.connection.close();
			source = undefined;
			return;
		}

		if (current === source.seen) return;
		source.seen = current;
		notify();
	};

	const rung = () => {
		if (trailing) return;
		const wait = MIN_CHECK_INTERVAL_MS - (performance.now() - checkedAt);
		if (wait <= 0) check();
		else trailing = setTimeout(check, wait);
	};

	const bell = path.basename(stateBellPath(dbPath));
	mkdirSync(path.dirname(dbPath), {recursive: true});
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(path.dirname(dbPath), (_event, filename) => {
			if (filename === bell) rung();
		});
	} catch {
		// Without a watch the poll below is the only signal.
	}

	const poll = setInterval(() => {
		if (source) {
			check();
			return;
		}

		source = openSource(dbPath);
		// Nothing was seen of the commits made while the database could not be
		// opened, so what the listeners last read may be out of date.
		if (source) notify();
	}, FALLBACK_POLL_MS);
	poll.unref();

	return {
		listeners,
		close() {
			clearInterval(poll);
			clearTimeout(trailing);
			watcher?.close();
			source?.connection.close();
		},
	};
}

/**
 * Call `listener` after any process commits a change to the database at
 * `dbPath`. It is not told what changed; it reads its own rows again.
 *
 * A database that cannot be opened is tried again on the poll, and the
 * listeners are called once when it opens.
 */
export function onStateDbChange(
	dbPath: string,
	listener: () => void,
): () => void {
	let entry = watches.get(dbPath);
	if (!entry) {
		entry = startWatch(dbPath);
		watches.set(dbPath, entry);
	}

	entry.listeners.add(listener);
	return () => {
		entry.listeners.delete(listener);
		if (entry.listeners.size === 0) {
			entry.close();
			watches.delete(dbPath);
		}
	};
}

/** Resolve when the database changes, or after `ms`, whichever is first. */
export async function waitForStateDbChange(
	dbPath: string,
	ms: number,
): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(done, ms);
		const stop = onStateDbChange(dbPath, done);
		function done() {
			clearTimeout(timer);
			stop();
			resolve();
		}
	});
}
