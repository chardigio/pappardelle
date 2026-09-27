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
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

// Live owners keep their lock regardless of age. Empty abandoned lock
// directories can be removed after this grace period. Contention times out
// without running the mutation; callers can retry safely.
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
 * Override advisory-lock timings for contention tests.
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
		return parseRegistry(fs.readFileSync(p, 'utf-8'));
	} catch {
		// File doesn't exist yet or is invalid — start with empty list
		return [];
	}
}

function parseRegistry(content: string): string[] {
	const parsed: unknown = JSON.parse(content);
	if (!Array.isArray(parsed)) throw new Error('Invalid workspace registry');
	return [
		...new Set(parsed.filter((key): key is string => typeof key === 'string')),
	];
}

function readRegistryForMutation(p: string): string[] {
	try {
		return parseRegistry(fs.readFileSync(p, 'utf8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * Get all registered space keys (issue keys like "STA-123").
 * Returns a deduplicated array, read fresh from disk on every call.
 */
export function getRegisteredSpaces(): string[] {
	return readFromDisk(registryPath);
}

/** A failed refresh must not look like an empty registry and remove every row. */
export async function getRegisteredSpacesAsync(): Promise<string[] | null> {
	try {
		return parseRegistry(await readFile(registryPath, 'utf-8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * Add a space to the registry. No-op if already present.
 */
export async function addSpace(
	issueKey: string,
	signal?: AbortSignal,
): Promise<void> {
	await withRegistryLock(p => {
		const keys = readRegistryForMutation(p);
		if (keys.includes(issueKey)) return; // already present — skip no-op write
		writeJsonAtomic(p, [...keys, issueKey]);
	}, signal);
}

/**
 * Remove a space from the registry, and free the watchlist slot it held (if
 * any) so reopening the issue by hand later isn't counted against a watchlist.
 */
export async function removeSpace(
	issueKey: string,
	signal?: AbortSignal,
): Promise<void> {
	await withRegistryLock(p => {
		const keys = readRegistryForMutation(p);
		if (keys.includes(issueKey)) {
			writeJsonAtomic(
				p,
				keys.filter(k => k !== issueKey),
			);
		}

		const reservations = readReservations(p);
		if (reservations.delete(issueKey)) writeReservations(p, reservations);
	}, signal);
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
function writeJsonAtomic(p: string, data: unknown): void {
	const tmp = `${p}.tmp.${process.pid}.${randomUUID()}`;
	try {
		fs.mkdirSync(path.dirname(p), {recursive: true});
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
		fs.renameSync(tmp, p);
	} finally {
		fs.rmSync(tmp, {force: true});
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

function getReservationsPath(p: string): string {
	return path.join(path.dirname(p), 'watchlist-spawns.json');
}

function readReservations(p: string): Map<string, WatchlistReservation> {
	const reservations = new Map<string, WatchlistReservation>();
	try {
		const parsed: unknown = JSON.parse(
			fs.readFileSync(getReservationsPath(p), 'utf-8'),
		);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('Invalid watchlist reservations');
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
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}

	return reservations;
}

function writeReservations(
	p: string,
	reservations: Map<string, WatchlistReservation>,
): void {
	writeJsonAtomic(getReservationsPath(p), Object.fromEntries(reservations));
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
export async function tryReserveWatchlistSlots(
	source: string,
	candidateKeys: string[],
	max: number,
	opts: {
		pid?: number;
		isPidAlive?: (pid: number) => boolean;
		signal?: AbortSignal;
	} = {},
): Promise<{reserved: string[]; occupied: number; claimedElsewhere: string[]}> {
	const pid = opts.pid ?? process.pid;
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

	return withRegistryLock(p => {
		const registered = new Set(readRegistryForMutation(p));
		const reservations = readReservations(p);
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

		if (changed) writeReservations(p, reservations);
		return {reserved, occupied, claimedElsewhere};
	}, opts.signal);
}

/**
 * Give back a reservation whose idow run failed. A key that did get
 * registered keeps its entry, since that workspace still holds the slot.
 */
export async function releaseWatchlistReservation(
	issueKey: string,
): Promise<void> {
	await withRegistryLock(p => {
		if (readRegistryForMutation(p).includes(issueKey)) return;
		const reservations = readReservations(p);
		if (reservations.delete(issueKey)) writeReservations(p, reservations);
	});
}

const mutationQueues = new Map<string, Promise<unknown>>();

async function withRegistryLock<T>(
	fn: (p: string) => T,
	signal?: AbortSignal,
): Promise<T> {
	const p = registryPath;
	const previous = mutationQueues.get(p) ?? Promise.resolve();
	const task = previous
		.catch(() => {})
		.then(async () => {
			signal?.throwIfAborted();
			const lockPath = `${p}.lock`;
			fs.mkdirSync(path.dirname(lockPath), {recursive: true});
			const owner = `${process.pid}-${randomUUID()}`;
			const marker = path.join(lockPath, owner);
			const deadline = Date.now() + lockTimeoutMs;
			for (;;) {
				signal?.throwIfAborted();
				let acquired = false;
				try {
					fs.mkdirSync(lockPath);
					try {
						fs.writeFileSync(marker, '', {flag: 'wx'});
						// A dead-owner reaper may remove an empty directory while its creator
						// is descheduled. Only the sole marker owner may enter the critical section.
						const entries = fs.readdirSync(lockPath);
						if (entries.length === 1 && entries[0] === owner) {
							acquired = true;
						}
					} finally {
						if (!acquired) {
							fs.rmSync(marker, {force: true});
							removeEmptyLock(lockPath);
						}
					}
				} catch (err) {
					if (
						!['EEXIST', 'ENOENT'].includes(
							(err as NodeJS.ErrnoException).code ?? '',
						)
					)
						throw err;
					reapDeadOwners(lockPath);
				}
				if (acquired) {
					try {
						signal?.throwIfAborted();
						return fn(p);
					} finally {
						fs.rmSync(marker, {force: true});
						removeEmptyLock(lockPath);
					}
				}
				if (Date.now() >= deadline)
					throw new Error(
						`Registry lock timed out after ${lockTimeoutMs}ms: ${p}`,
					);
				await delay(lockRetryMs, undefined, {signal});
			}
		});
	mutationQueues.set(p, task);
	try {
		return await task;
	} finally {
		if (mutationQueues.get(p) === task) mutationQueues.delete(p);
	}
}

function removeEmptyLock(lockPath: string): void {
	try {
		fs.rmdirSync(lockPath);
	} catch (err) {
		if (
			!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
				(err as NodeJS.ErrnoException).code ?? '',
			)
		)
			throw err;
	}
}

function reapDeadOwners(lockPath: string): void {
	try {
		const entries = fs.readdirSync(lockPath);
		let removed = false;
		for (const entry of entries) {
			const match = /^(\d+)-[\da-f-]+$/.exec(entry);
			if (match && !defaultIsPidAlive(Number(match[1]))) {
				// A unique filename prevents a concurrent reaper from deleting a new
				// holder's marker after the dead owner's directory has been replaced.
				fs.rmSync(path.join(lockPath, entry), {force: true});
				removed = true;
			}
		}
		if (
			removed ||
			(entries.length === 0 &&
				Date.now() - fs.statSync(lockPath).mtimeMs > lockStaleMs)
		)
			removeEmptyLock(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}
