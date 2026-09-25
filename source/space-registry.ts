// Persisted space registry
// Tracks which spaces (issue keys) are "open" in Pappardelle.
// Previously, spaces were discovered by listing active tmux sessions,
// which meant they disappeared after a reboot or tmux server kill.
// This registry persists to disk so spaces survive across restarts.
//
// Registry files are namespaced per-repo under ~/.pappardelle/repos/{repoName}/
// to keep state completely separate when running pappardelle in multiple repos.
//
// STA-1553: the registry is shared by EVERY Pappardelle instance running against
// the same repo (multiple windows, plus each instance's independent watchlist
// auto-spawn loop). The original design read disk once into a process-lifetime
// cache and persisted via full-array overwrite, which is only safe with a single
// writer. With concurrent writers it produced classic lost updates: a stale
// instance overwrote the file with its own outdated array, silently dropping a
// space another instance had just added — even though that space's inner-socket
// sessions and git worktree were still alive. The next startup's reaper then saw
// those live-but-unregistered sessions as orphans and killed them ("reaped N
// orphaned inner-socket session(s)"), risking destruction of in-flight work.
//
// The fix treats disk as the single source of truth: reads always hit disk (no
// long-lived cache to go stale) and every mutation is a read-modify-write held
// under an advisory file lock, re-reading the CURRENT on-disk state and applying
// only its own delta before writing atomically (temp file + rename). An instance
// therefore merges with, rather than clobbers, additions made out-of-band.

import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {createLogger} from './logger.ts';

const log = createLogger('space-registry');

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

// Advisory-lock tuning. Critical sections are sub-millisecond (read a tiny JSON
// file, splice one key, rename), so contention is brief. We wait up to
// `lockTimeoutMs` for the lock and, rather than hang the UI on a wedged holder,
// proceed lock-less past that deadline (logging a warning, since that path can
// reintroduce the lost update this module exists to prevent). A lock whose mtime
// is older than `lockStaleMs` belonged to a crashed holder and is stolen.
// Mutable so tests can exercise the fallback without a multi-second wait.
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
let lockStaleMs = DEFAULT_LOCK_STALE_MS;
let lockRetryMs = DEFAULT_LOCK_RETRY_MS;

// Legacy path (pre-repo-namespacing) — used for migration
function getLegacyRegistryPath(baseDir: string): string {
	return path.join(baseDir, 'open-spaces.json');
}

/**
 * Get the registry file path for a specific repo.
 * Returns ~/.pappardelle/repos/{repoName}/open-spaces.json
 */
export function getRegistryPathForRepo(
	repoName: string,
	baseDir?: string,
): string {
	const base = baseDir ?? DEFAULT_BASE_DIR;
	return path.join(base, 'repos', repoName, 'open-spaces.json');
}

let registryPath = getLegacyRegistryPath(DEFAULT_BASE_DIR);

/**
 * Initialize the registry for a specific repo.
 * Sets the registry path to the repo-namespaced location and
 * migrates legacy data if this is the first run with the new layout.
 */
export function initForRepo(repoName: string, baseDir?: string): void {
	const base = baseDir ?? DEFAULT_BASE_DIR;
	const repoPath = getRegistryPathForRepo(repoName, base);

	// Migrate legacy global open-spaces.json — always clean it up if it exists.
	// If the repo-specific file doesn't exist yet, move legacy data there.
	// If it already exists, just delete the legacy file to complete migration.
	const legacyPath = getLegacyRegistryPath(base);
	if (fs.existsSync(legacyPath)) {
		try {
			if (!fs.existsSync(repoPath)) {
				const dir = path.dirname(repoPath);
				fs.mkdirSync(dir, {recursive: true});
				fs.renameSync(legacyPath, repoPath);
			} else {
				fs.unlinkSync(legacyPath);
			}
		} catch {
			// Non-critical — will retry on next startup
		}
	}

	registryPath = repoPath;
}

/**
 * Override the registry file path (for testing).
 */
export function setRegistryPath(p: string): void {
	registryPath = p;
}

/**
 * Reset to default path (for testing cleanup).
 */
export function resetRegistryPath(): void {
	registryPath = getLegacyRegistryPath(DEFAULT_BASE_DIR);
}

/**
 * Override advisory-lock timings (for testing). Lets a test drive the lock-less
 * fallback path in milliseconds instead of waiting out the real ~5s timeout.
 */
export function setLockTimingForTests(opts: {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
}): void {
	if (opts.timeoutMs !== undefined) lockTimeoutMs = opts.timeoutMs;
	if (opts.staleMs !== undefined) lockStaleMs = opts.staleMs;
	if (opts.retryMs !== undefined) lockRetryMs = opts.retryMs;
}

/**
 * Restore default advisory-lock timings (for testing cleanup).
 */
export function resetLockTimingForTests(): void {
	lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
	lockStaleMs = DEFAULT_LOCK_STALE_MS;
	lockRetryMs = DEFAULT_LOCK_RETRY_MS;
}

/**
 * Read the registry array straight from disk, deduplicated and filtered to
 * strings. Returns [] when the file is missing or invalid. This is the single
 * source of truth — there is no in-memory cache to go stale behind a concurrent
 * writer (STA-1553).
 */
function readFromDisk(p: string): string[] {
	try {
		const data = fs.readFileSync(p, 'utf-8');
		const parsed: unknown = JSON.parse(data);
		if (Array.isArray(parsed)) {
			const seen = new Set<string>();
			for (const v of parsed) {
				if (typeof v === 'string') seen.add(v);
			}
			return [...seen];
		}
	} catch {
		// File doesn't exist yet or is invalid — start with empty list
	}
	return [];
}

/**
 * Get all registered space keys (issue keys like "STA-123").
 * Returns a deduplicated array, read fresh from disk on every call.
 */
export function getRegisteredSpaces(): string[] {
	return readFromDisk(registryPath);
}

/**
 * Add a space to the registry. No-op if already present.
 */
export function addSpace(issueKey: string): void {
	withRegistryLock(() => {
		const keys = readFromDisk(registryPath);
		if (keys.includes(issueKey)) return; // already present — skip no-op write
		writeToDisk([...keys, issueKey]);
	});
}

/**
 * Remove a space from the registry, and free the watchlist slot it held (if
 * any) so reopening the issue by hand later isn't counted against a watchlist.
 */
export function removeSpace(issueKey: string): void {
	withRegistryLock(() => {
		const keys = readFromDisk(registryPath);
		if (keys.includes(issueKey)) {
			writeToDisk(keys.filter(k => k !== issueKey));
		}

		const reservations = readReservations();
		if (reservations.delete(issueKey)) writeReservations(reservations);
	});
}

/**
 * Check if a space is registered.
 */
export function isSpaceRegistered(issueKey: string): boolean {
	return getRegisteredSpaces().includes(issueKey);
}

/**
 * Persist the registry atomically: write a sibling temp file then rename over
 * the target so a reader never observes a half-written file (and a crash mid-
 * write can't truncate the registry to empty — which would itself look like a
 * mass-orphan event to the reaper).
 */
function writeToDisk(keys: string[]): void {
	writeJsonAtomic(registryPath, keys);
}

function writeJsonAtomic(p: string, data: unknown): void {
	try {
		fs.mkdirSync(path.dirname(p), {recursive: true});
		const tmp = `${p}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
		fs.renameSync(tmp, p);
	} catch {
		// Non-critical — registry will be rebuilt on next session creation
	}
}

// ---------------------------------------------------------------------------
// Watchlist slot reservations (STE-25)
//
// A watchlist with `max_workspaces` reserves a slot here before spawning idow,
// and the entry keeps holding that slot while the space is registered. Until
// then it holds only while the pappardelle process that reserved it is alive:
// that process is the only one that will call addSpace when idow exits, so a
// dead owner's reservation can never become a workspace. Reserving under the
// registry lock is what stops two instances on the same repo from each seeing
// free capacity and spawning past the cap together.
// ---------------------------------------------------------------------------

type WatchlistReservation = {source: string; ownerPid: number};

function getReservationsPath(): string {
	return path.join(path.dirname(registryPath), 'watchlist-spawns.json');
}

function readReservations(): Map<string, WatchlistReservation> {
	const reservations = new Map<string, WatchlistReservation>();
	try {
		const parsed: unknown = JSON.parse(
			fs.readFileSync(getReservationsPath(), 'utf-8'),
		);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				const entry = value as Partial<WatchlistReservation> | null;
				if (
					typeof entry?.source === 'string' &&
					typeof entry.ownerPid === 'number'
				) {
					reservations.set(key, {
						source: entry.source,
						ownerPid: entry.ownerPid,
					});
				}
			}
		}
	} catch {
		// Missing or invalid — no reservations
	}

	return reservations;
}

function writeReservations(
	reservations: Map<string, WatchlistReservation>,
): void {
	writeJsonAtomic(getReservationsPath(), Object.fromEntries(reservations));
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Reserve up to `max` minus the slots `source` already holds, taking
 * `candidateKeys` in order. Keys that are already registered or reserved are
 * returned in `claimedElsewhere` instead: the caller should treat them as
 * spawned, since another instance or watchlist owns them. `occupied` is how
 * many slots `source` held before this call.
 */
export function tryReserveWatchlistSlots(
	source: string,
	candidateKeys: string[],
	max: number,
	opts: {pid?: number; isPidAlive?: (pid: number) => boolean} = {},
): {reserved: string[]; occupied: number; claimedElsewhere: string[]} {
	const pid = opts.pid ?? process.pid;
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

	return withRegistryLock(() => {
		const registered = new Set(readFromDisk(registryPath));
		const reservations = readReservations();
		let changed = false;

		for (const [key, entry] of reservations) {
			if (!registered.has(key) && !isPidAlive(entry.ownerPid)) {
				reservations.delete(key);
				changed = true;
			}
		}

		const occupied = [...reservations.values()].filter(
			entry => entry.source === source,
		).length;
		const reserved: string[] = [];
		const claimedElsewhere: string[] = [];
		for (const key of candidateKeys) {
			if (registered.has(key) || reservations.has(key)) {
				claimedElsewhere.push(key);
				continue;
			}

			if (occupied + reserved.length >= max) continue;
			reservations.set(key, {source, ownerPid: pid});
			reserved.push(key);
			changed = true;
		}

		if (changed) writeReservations(reservations);
		return {reserved, occupied, claimedElsewhere};
	});
}

/**
 * Give back a reservation whose idow run failed. A key that did get
 * registered keeps its entry, since that workspace still holds the slot.
 */
export function releaseWatchlistReservation(issueKey: string): void {
	withRegistryLock(() => {
		if (readFromDisk(registryPath).includes(issueKey)) return;
		const reservations = readReservations();
		if (reservations.delete(issueKey)) writeReservations(reservations);
	});
}

/**
 * Block the current thread for `ms` without busy-spinning. Atomics.wait on a
 * throwaway SharedArrayBuffer is the standard dependency-free synchronous sleep;
 * the registry API is synchronous (called from React effects and the CLI), so we
 * can't yield to the event loop here.
 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive advisory lock on `<registryPath>.lock`.
 * Acquisition uses the atomic `wx` (O_CREAT|O_EXCL) open as the mutex. A lock
 * left by a crashed holder (mtime older than `lockStaleMs`) is stolen; if the
 * lock can't be acquired within `lockTimeoutMs` we proceed without it rather
 * than wedge the UI — at sub-millisecond critical sections that deadline is
 * effectively unreachable in practice, and the fallback is logged so the rare
 * case is debuggable.
 */
function withRegistryLock<T>(fn: () => T): T {
	const lockPath = `${registryPath}.lock`;
	try {
		fs.mkdirSync(path.dirname(lockPath), {recursive: true});
	} catch {
		// Directory creation failure surfaces again in writeToDisk; ignore here.
	}

	const deadline = Date.now() + lockTimeoutMs;
	let fd: number | undefined;
	for (;;) {
		try {
			fd = fs.openSync(lockPath, 'wx');
			break;
		} catch {
			// Lock is held. Steal it if the holder crashed (stale mtime), else wait.
			try {
				const age = Date.now() - fs.statSync(lockPath).mtimeMs;
				if (age > lockStaleMs) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch {
				// Lock vanished between open and stat — retry acquisition immediately.
				continue;
			}

			if (Date.now() >= deadline) {
				// Give up waiting and proceed lock-less. This reopens the lost-update
				// window, so surface it: log.warn routes to the log file and the TUI
				// error overlay (unlike a raw console write, which would corrupt Ink's
				// frame — STA-1496).
				log.warn(
					`Registry lock on ${lockPath} held longer than ${lockTimeoutMs}ms; proceeding without it — a concurrent write may be lost.`,
				);
				break;
			}

			sleepSync(lockRetryMs);
		}
	}

	try {
		return fn();
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Already closed — nothing to recover.
			}

			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Lock already removed (e.g. stolen as stale) — fine.
			}
		}
	}
}
