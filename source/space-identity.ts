// What a space is called: its repo and key, its worktree, and the tmux
// sessions it runs in. Decided once, when the space is created, and looked
// up by everything that runs after.

import fs from 'node:fs';
import path from 'node:path';
import {sameFile} from './same-file.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {SpaceRegistryDao} from './space-registry.ts';
import type {Unreadable} from './state-db.ts';

export type SpaceIdentity = {
	repo: string;
	key: string;
	worktreePath: string;
	tmux: {socket: string; agentSession: string; companionSession: string};
};

export type SpaceIdentityLookup =
	| {kind: 'identity'; identity: SpaceIdentity}
	| {kind: 'unknown'}
	| Unreadable;

export type SpaceIdentityList =
	| {kind: 'identities'; identities: SpaceIdentity[]}
	| Unreadable;

export interface SpaceIdentityDao {
	get(key: string): SpaceIdentityLookup;
	/** Every identity of this repo, open or closed, main included. */
	list(): SpaceIdentityList;
	/** The space whose worktree holds `path`, compared by file identity (`sameFile`). */
	atPath(path: string): SpaceIdentityLookup;
	record(identity: SpaceIdentity): Promise<void>;
}

/**
 * tmux 3.6 and older store `.` and `:` in a session name as `_`, so the repo
 * part of a session name is spelled this way to read back the same on every
 * release.
 */
export function tmuxSessionRepo(repoName: string): string {
	return repoName.replaceAll(/[.:]/g, '_');
}

export type SessionKind = 'agent' | 'companion' | 'claude';

/**
 * The start of every session name of this kind in a repo. `claude` is the
 * agent's name before it was renamed to `agent`, still swept by the reapers.
 */
export function sessionPrefix(kind: SessionKind, repoName: string): string {
	return `${kind}-${tmuxSessionRepo(repoName)}-`;
}

/**
 * The session names a space is created with. tmux reads `.` in a target as a
 * window separator, so the key's `.` becomes `_`, and a `_` it already had is
 * doubled to stay distinct.
 */
export function sessionNamesFor(
	issueKey: string,
	repoName: string,
): {agent: string; companion: string; legacyAgent: string} {
	const key = issueKey.replaceAll('_', '__').replaceAll('.', '_');
	return {
		agent: `${sessionPrefix('agent', repoName)}${key}`,
		companion: `${sessionPrefix('companion', repoName)}${key}`,
		legacyAgent: `${sessionPrefix('claude', repoName)}${key}`,
	};
}

/** The name a space's agent session had before it was renamed to agent-. */
export function legacyAgentSession(agentSession: string): string {
	return agentSession.replace(/^agent-/, 'claude-');
}

/** The names a space gets when it is created. */
export function newSpaceIdentity(input: {
	repo: string;
	key: string;
	worktreePath: string;
	socket: string;
}): SpaceIdentity {
	const sessions = sessionNamesFor(input.key, input.repo);
	return {
		repo: input.repo,
		key: input.key,
		worktreePath: input.worktreePath,
		tmux: {
			socket: input.socket,
			agentSession: sessions.agent,
			companionSession: sessions.companion,
		},
	};
}

/** Where Pappardelle puts a repo's worktrees, one per space. */
export function worktreesDir(home: string, repoName: string): string {
	return path.join(home, '.worktrees', repoName);
}

export function worktreePathFor(
	home: string,
	repoName: string,
	key: string,
): string {
	return path.join(worktreesDir(home, repoName), key);
}

/** What a space created by idow with today's defaults is called. */
export type IdentityDefaults = {
	repo: string;
	home: string;
	socket: string;
	/** The main checkout's root. Throws outside a git checkout. */
	mainRoot: () => string;
};

export function defaultIdentity(
	defaults: IdentityDefaults,
	key: string,
): SpaceIdentity {
	return newSpaceIdentity({
		repo: defaults.repo,
		key,
		worktreePath:
			key === MAIN_WORKTREE_KEY
				? defaults.mainRoot()
				: worktreePathFor(defaults.home, defaults.repo, key),
		socket: defaults.socket,
	});
}

/** Identities without the database: every space is called what idow would call it. */
export class JsonSpaceIdentityDao implements SpaceIdentityDao {
	constructor(
		private readonly defaults: IdentityDefaults,
		private readonly registry: Pick<SpaceRegistryDao, 'openSpaces'>,
	) {}

	get(key: string): SpaceIdentityLookup {
		try {
			return {kind: 'identity', identity: defaultIdentity(this.defaults, key)};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	list(): SpaceIdentityList {
		try {
			const keys = [MAIN_WORKTREE_KEY, ...(this.registry.openSpaces() ?? [])];
			return {
				kind: 'identities',
				identities: keys.map(key => defaultIdentity(this.defaults, key)),
			};
		} catch (error) {
			return {kind: 'unreadable', error};
		}
	}

	atPath(at: string): SpaceIdentityLookup {
		const {home, repo} = this.defaults;
		let mainRoot: string;
		try {
			mainRoot = this.defaults.mainRoot();
		} catch (error) {
			return {kind: 'unreadable', error};
		}

		const worktrees = worktreesDir(home, repo);
		let directory: string;
		try {
			directory = fs.realpathSync(at);
		} catch {
			return {kind: 'unknown'};
		}

		for (;;) {
			if (sameFile(directory, mainRoot)) return this.get(MAIN_WORKTREE_KEY);
			const parent = path.dirname(directory);
			if (parent === directory) return {kind: 'unknown'};
			if (sameFile(parent, worktrees))
				return this.get(path.basename(directory));
			directory = parent;
		}
	}

	async record(): Promise<void> {}
}

/**
 * The identity whose worktree is `at` or its nearest ancestor. Directories
 * are compared by device and inode, as `sameFile` does, so a path reached
 * through a symlink belongs to the same space.
 */
export function identityAt(
	at: string,
	identities: readonly SpaceIdentity[],
): SpaceIdentity | undefined {
	const byFile = new Map<string, SpaceIdentity>();
	for (const identity of identities) {
		const id = fileId(identity.worktreePath);
		if (id) byFile.set(id, identity);
	}

	let directory: string;
	try {
		directory = fs.realpathSync(at);
	} catch {
		return undefined;
	}

	for (;;) {
		const id = fileId(directory);
		const found = id ? byFile.get(id) : undefined;
		if (found) return found;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function fileId(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
}

export type ProtectedSessionNames =
	| {kind: 'names'; names: ReadonlySet<string>}
	| {kind: 'missing'; keys: string[]}
	| Unreadable;

/**
 * The session names the reaper keeps: those of every space the registry
 * protects, and main's. A protected space without an identity is `missing`,
 * since reaping without its names would kill its sessions.
 */
export function protectedSessionNames(
	registry: Pick<SpaceRegistryDao, 'protectedSpaces'>,
	identities: Pick<SpaceIdentityDao, 'list'>,
): ProtectedSessionNames {
	const owned = registry.protectedSpaces();
	if (!owned.ok) return {kind: 'unreadable', error: owned.error};
	const listed = identities.list();
	if (listed.kind === 'unreadable') return listed;
	const byKey = new Map(
		listed.identities.map(identity => [identity.key, identity]),
	);
	const names = new Set<string>();
	const missing: string[] = [];
	for (const key of [MAIN_WORKTREE_KEY, ...owned.keys]) {
		const identity = byKey.get(key);
		if (identity) {
			names.add(identity.tmux.agentSession);
			names.add(identity.tmux.companionSession);
		} else {
			missing.push(key);
		}
	}

	return missing.length > 0
		? {kind: 'missing', keys: missing}
		: {kind: 'names', names};
}
