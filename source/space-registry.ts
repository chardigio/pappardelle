// The space registry: which spaces (issue keys) are open in Pappardelle, so
// that spaces survive a reboot or a tmux server kill. Every Pappardelle of a
// repo shares it, along with each one's watchlist auto-spawn loop, and the
// startup reaper kills the sessions of spaces it does not list, so a write
// that drops another's space destroys work. Each change is its own write
// transaction in the state database (space-registry-sqlite.ts).

import path from 'node:path';
import {isPidAlive as defaultIsPidAlive} from './file-lock.ts';
import {DEFAULT_STATE_DIR, type Unreadable} from './state-db.ts';

export type SpacePhase = 'starting' | 'open' | 'closing';

/** What a registry records about one space. */
export type SpacePhaseLookup =
	| {kind: 'phase'; phase: SpacePhase}
	| {kind: 'unknown'}
	| Unreadable;

export type WatchlistSlots = {
	reserved: string[];
	occupied: number;
	claimedElsewhere: string[];
};

export type WatchlistReserveOptions = {
	pid?: number;
	isPidAlive?: (pid: number) => boolean;
};

/** What the reaper may rely on: every space whose sessions have an owner. */
export type ProtectedSpaces =
	| {ok: true; keys: string[]}
	| {ok: false; error: unknown};

/** What `settle` needs to finish closes and starts their process abandoned. */
export type SettleDeps = {
	/** Closes this process is still running. */
	closing: Pick<ReadonlySet<string>, 'has'>;
	/** Every live inner tmux session, or null when tmux did not answer. */
	liveSessions: () => ReadonlySet<string> | null;
};

/**
 * The spaces a repo has open. One instance belongs to one repo.
 *
 * `starting` and `closing` spaces are not open, so they are not listed, but
 * their sessions are theirs.
 */
export interface SpaceRegistryDao {
	/** Open spaces. Throws when they cannot be read: that must never look empty. */
	openSpaces(): string[];
	protectedSpaces(): ProtectedSpaces;
	/** Whether the space is open, being set up or being torn down. */
	has(key: string): boolean;
	phase(key: string): SpacePhaseLookup;

	add(key: string): Promise<void>;
	remove(key: string): Promise<void>;

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
		return registry.openSpaces();
	} catch {
		return [];
	}
}

/** Where a repo's registry file was, for the one-time import. */
export function getRegistryPathForRepo(
	repoName: string,
	baseDir = DEFAULT_STATE_DIR,
): string {
	return path.join(baseDir, 'repos', repoName, 'open-spaces.json');
}

/** The keys in a registry file. Throws when it does not hold a list. */
export function parseRegistry(content: string): string[] {
	const parsed: unknown = JSON.parse(content);
	if (!Array.isArray(parsed)) throw new Error('Invalid workspace registry');
	return [
		...new Set(parsed.filter((key): key is string => typeof key === 'string')),
	];
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
