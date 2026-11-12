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
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isPidAlive as defaultIsPidAlive, withFileLock} from './file-lock.ts';
import {DEFAULT_STATE_DIR} from './state-db.ts';

export type WatchlistSlots = {
	reserved: string[];
	occupied: number;
	claimedElsewhere: string[];
};

export type WatchlistReserveOptions = {
	pid?: number;
	isPidAlive?: (pid: number) => boolean;
	signal?: AbortSignal;
};

/** What the reaper may rely on: every space whose sessions have an owner. */
export type ProtectedSpaces =
	| {ok: true; keys: string[]}
	| {ok: false; error: unknown};

/** What `settle` needs to finish closes and starts their process abandoned. */
export type SettleDeps = {
	/** Closes this process is still running. */
	closing: ReadonlySet<string>;
	/** Space keys with a live tmux session, or null when tmux did not answer. */
	liveSessionKeys: () => ReadonlySet<string> | null;
};

/**
 * The spaces a repo has open. One instance belongs to one repo.
 *
 * `starting` and `closing` spaces exist only where `keepsLifecycle` is true.
 * They are not open, so they are not listed, but their sessions are theirs.
 */
export interface SpaceRegistryDao {
	/**
	 * Whether a space is recorded while it is being set up or torn down. Where
	 * it is not, the lifecycle methods below do nothing.
	 */
	readonly keepsLifecycle: boolean;

	/**
	 * Open spaces, or null when no registry has been written yet. Throws when
	 * the registry exists and cannot be read: that must never look empty.
	 */
	openSpaces(): string[] | null;
	/** `openSpaces`, read off the event loop where the store allows it. */
	openSpacesAsync(): Promise<string[] | null>;
	protectedSpaces(): ProtectedSpaces;
	/** Whether the space is open, being set up or being torn down. */
	has(key: string): boolean;

	add(key: string, signal?: AbortSignal): Promise<void>;
	remove(key: string, signal?: AbortSignal): Promise<void>;

	/**
	 * Record a space before its sessions exist, owned by the process setting
	 * it up, so a failure here stops setup instead of leaving sessions that
	 * belong to nothing.
	 */
	reserveStart(key: string, ownerPid: number): Promise<void>;
	/** Record that this process is tearing the space down. */
	markClosing(key: string): Promise<void>;
	/** Undo `markClosing` when the sessions could not be killed. */
	reopen(key: string): Promise<void>;
	/** Finish what a process started and did not see through. */
	settle(deps: SettleDeps): Promise<void>;

	tryReserveWatchlistSlots(
		source: string,
		candidateKeys: string[],
		max: number,
		options?: WatchlistReserveOptions,
	): Promise<WatchlistSlots>;
	releaseWatchlistReservation(key: string): Promise<void>;
}

/** Open spaces for a caller that treats an unreadable registry as none. */
export function listOpenSpaces(registry: SpaceRegistryDao): string[] {
	try {
		return registry.openSpaces() ?? [];
	} catch {
		return [];
	}
}

/**
 * Get the registry file path for a specific repo.
 * Returns ~/.pappardelle/repos/{repoName}/open-spaces.json
 */
export function getRegistryPathForRepo(
	repoName: string,
	baseDir = DEFAULT_STATE_DIR,
): string {
	return path.join(baseDir, 'repos', repoName, 'open-spaces.json');
}

/** Every repo with pappardelle state, by the name its sessions carry. */
export function listKnownRepos(baseDir = DEFAULT_STATE_DIR): string[] {
	try {
		return fs.readdirSync(path.join(baseDir, 'repos'));
	} catch {
		return [];
	}
}

/**
 * Move the registry from its pre-repo-namespacing path, the first time a repo
 * runs with the per-repo layout.
 */
export function migrateLegacyRegistry(
	repoName: string,
	baseDir = DEFAULT_STATE_DIR,
): void {
	const repoPath = getRegistryPathForRepo(repoName, baseDir);

	// Migrate legacy global open-spaces.json — always clean it up if it exists.
	// If the repo-specific file doesn't exist yet, move legacy data there.
	// If it already exists, just delete the legacy file to complete migration.
	const legacyPath = path.join(baseDir, 'open-spaces.json');
	if (fs.existsSync(legacyPath)) {
		try {
			if (fs.existsSync(repoPath)) {
				fs.unlinkSync(legacyPath);
			} else {
				const dir = path.dirname(repoPath);
				fs.mkdirSync(dir, {recursive: true});
				fs.renameSync(legacyPath, repoPath);
			}
		} catch {
			// Non-critical — will retry on next startup
		}
	}
}

/** The keys in a registry file. Throws when it does not hold a list. */
export function parseRegistry(content: string): string[] {
	const parsed: unknown = JSON.parse(content);
	if (!Array.isArray(parsed)) throw new Error('Invalid workspace registry');
	return [
		...new Set(parsed.filter((key): key is string => typeof key === 'string')),
	];
}

/** A registry file's content for these keys. */
export function renderRegistry(keys: readonly string[]): string {
	return JSON.stringify(keys, null, 2) + '\n';
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

export type WatchlistReservation = {source: string; ownerPid: number};

/** The reservations in a sidecar file. Throws when it does not hold any. */
export function parseWatchlistReservations(
	content: string,
): Map<string, WatchlistReservation> {
	const reservations = new Map<string, WatchlistReservation>();
	const parsed: unknown = JSON.parse(content);
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

	return reservations;
}

/** A sidecar file's content for these reservations. */
export function renderWatchlistReservations(
	reservations: ReadonlyMap<string, WatchlistReservation>,
): string {
	return JSON.stringify(Object.fromEntries(reservations), null, 2) + '\n';
}

/**
 * Reserve up to `max` minus the slots `source` already holds, taking
 * `candidateKeys` in order. Keys that are already registered or reserved are
 * returned in `claimedElsewhere` instead: the caller should treat them as
 * spawned, since another instance or watchlist owns them. `occupied` is how
 * many slots `source` held before this call.
 *
 * `reservations` is changed in place, and `changed` says whether it was.
 */
export function reserveWatchlistSlots(
	reservations: Map<string, WatchlistReservation>,
	registered: ReadonlySet<string>,
	source: string,
	candidateKeys: string[],
	max: number,
	options: WatchlistReserveOptions,
): {slots: WatchlistSlots; changed: boolean} {
	const pid = options.pid ?? process.pid;
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
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

	return {slots: {reserved, occupied, claimedElsewhere}, changed};
}

/**
 * The watchlist reservations beside a registry file. Every method must run
 * while the registry's lock is held.
 */
export class WatchlistReservationFile {
	readonly file: string;

	constructor(registryPath: string) {
		this.file = path.join(path.dirname(registryPath), 'watchlist-spawns.json');
	}

	reserve(
		registered: ReadonlySet<string>,
		source: string,
		candidateKeys: string[],
		max: number,
		options: WatchlistReserveOptions,
	): WatchlistSlots {
		const reservations = this.read();
		const {slots, changed} = reserveWatchlistSlots(
			reservations,
			registered,
			source,
			candidateKeys,
			max,
			options,
		);
		if (changed) this.write(reservations);
		return slots;
	}

	/** Free the slot `key` holds, if any. */
	drop(key: string): void {
		const reservations = this.read();
		if (reservations.delete(key)) this.write(reservations);
	}

	private read(): Map<string, WatchlistReservation> {
		try {
			return parseWatchlistReservations(fs.readFileSync(this.file, 'utf-8'));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			return new Map();
		}
	}

	private write(reservations: Map<string, WatchlistReservation>): void {
		writeJsonAtomic(this.file, Object.fromEntries(reservations));
	}
}

/** The registry as one JSON file per repo, guarded by an advisory lock. */
export class JsonSpaceRegistryDao implements SpaceRegistryDao {
	get keepsLifecycle(): boolean {
		return false;
	}

	readonly reservations: WatchlistReservationFile;

	constructor(readonly file: string) {
		this.reservations = new WatchlistReservationFile(file);
	}

	openSpaces(): string[] | null {
		try {
			return parseRegistry(fs.readFileSync(this.file, 'utf-8'));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
	}

	/** A failed refresh must not look like an empty registry and remove every row. */
	async openSpacesAsync(): Promise<string[] | null> {
		try {
			return parseRegistry(await readFile(this.file, 'utf-8'));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
	}

	/**
	 * The file is all this registry has, so the reaper is given whatever can
	 * be read from it, as it always has been.
	 */
	protectedSpaces(): ProtectedSpaces {
		return {ok: true, keys: listOpenSpaces(this)};
	}

	has(key: string): boolean {
		return listOpenSpaces(this).includes(key);
	}

	/** Add a space to the registry. No-op if already present. */
	async add(key: string, signal?: AbortSignal): Promise<void> {
		await this.locked(() => {
			const keys = this.readForMutation();
			if (keys.includes(key)) return; // already present — skip no-op write
			writeJsonAtomic(this.file, [...keys, key]);
		}, signal);
	}

	/**
	 * Remove a space from the registry, and free the watchlist slot it held (if
	 * any) so reopening the issue by hand later isn't counted against a watchlist.
	 */
	async remove(key: string, signal?: AbortSignal): Promise<void> {
		await this.locked(() => {
			const keys = this.readForMutation();
			if (keys.includes(key)) {
				writeJsonAtomic(
					this.file,
					keys.filter(k => k !== key),
				);
			}

			this.reservations.drop(key);
		}, signal);
	}

	async reserveStart(): Promise<void> {}

	async markClosing(): Promise<void> {}

	async reopen(): Promise<void> {}

	async settle(): Promise<void> {}

	async tryReserveWatchlistSlots(
		source: string,
		candidateKeys: string[],
		max: number,
		options: WatchlistReserveOptions = {},
	): Promise<WatchlistSlots> {
		return this.locked(
			() =>
				this.reservations.reserve(
					new Set(this.readForMutation()),
					source,
					candidateKeys,
					max,
					options,
				),
			options.signal,
		);
	}

	/**
	 * Give back a reservation whose idow run failed. A key that did get
	 * registered keeps its entry, since that workspace still holds the slot.
	 */
	async releaseWatchlistReservation(key: string): Promise<void> {
		await this.locked(() => {
			if (this.readForMutation().includes(key)) return;
			this.reservations.drop(key);
		});
	}

	/** Run `fn` holding the lock every writer of this registry file takes. */
	async locked<T>(fn: () => T, signal?: AbortSignal): Promise<T> {
		return withFileLock(this.file, fn, signal);
	}

	/** The keys to change: none yet for a new registry, never a guess for a bad one. */
	private readForMutation(): string[] {
		return this.openSpaces() ?? [];
	}
}
