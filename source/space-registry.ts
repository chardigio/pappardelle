// Persisted space registry
// Tracks which spaces (issue keys) are "open" in Pappardelle.
// Previously, spaces were discovered by listing active tmux sessions,
// which meant they disappeared after a reboot or tmux server kill.
// This registry persists to disk so spaces survive across restarts.
//
// Registry files are namespaced per-repo under ~/.pappardelle/repos/{repoName}/
// to keep state completely separate when running pappardelle in multiple repos.

import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_DIR = path.join(homedir(), '.pappardelle');

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
let cachedKeys: string[] | null = null;

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
	cachedKeys = null;
}

/**
 * Override the registry file path (for testing).
 */
export function setRegistryPath(p: string): void {
	registryPath = p;
	cachedKeys = null;
}

/**
 * Reset to default path (for testing cleanup).
 */
export function resetRegistryPath(): void {
	registryPath = getLegacyRegistryPath(DEFAULT_BASE_DIR);
	cachedKeys = null;
}

/**
 * Get all registered space keys (issue keys like "STA-123").
 * Returns a deduplicated array. Reads from disk on first call,
 * then uses an in-memory cache.
 */
export function getRegisteredSpaces(): string[] {
	if (cachedKeys !== null) return cachedKeys;
	try {
		const data = fs.readFileSync(registryPath, 'utf-8');
		const parsed = JSON.parse(data);
		if (Array.isArray(parsed)) {
			cachedKeys = parsed.filter((v): v is string => typeof v === 'string');
			return cachedKeys;
		}
	} catch {
		// File doesn't exist yet or is invalid — start with empty list
	}
	cachedKeys = [];
	return cachedKeys;
}

/**
 * Add a space to the registry. No-op if already present.
 */
export function addSpace(issueKey: string): void {
	const keys = getRegisteredSpaces();
	if (keys.includes(issueKey)) return;
	cachedKeys = [...keys, issueKey];
	persistToDisk();
}

/**
 * Remove a space from the registry. No-op if not present.
 */
export function removeSpace(issueKey: string): void {
	const keys = getRegisteredSpaces();
	if (!keys.includes(issueKey)) return;
	cachedKeys = keys.filter(k => k !== issueKey);
	persistToDisk();
}

/**
 * Check if a space is registered.
 */
export function isSpaceRegistered(issueKey: string): boolean {
	return getRegisteredSpaces().includes(issueKey);
}

/**
 * Seed the registry from active tmux sessions.
 * Adds any issue keys that have active sessions but aren't in the registry.
 * Used for migration from tmux-based discovery to persisted registry.
 */
export function seedFromTmux(tmuxIssueKeys: string[]): void {
	const keys = getRegisteredSpaces();
	const toAdd = tmuxIssueKeys.filter(k => !keys.includes(k));
	if (toAdd.length === 0) return;
	cachedKeys = [...keys, ...toAdd];
	persistToDisk();
}

function persistToDisk(): void {
	try {
		const dir = path.dirname(registryPath);
		fs.mkdirSync(dir, {recursive: true});
		fs.writeFileSync(
			registryPath,
			JSON.stringify(cachedKeys ?? [], null, 2) + '\n',
		);
	} catch {
		// Non-critical — registry will be rebuilt on next session creation
	}
}
