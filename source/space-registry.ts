// Persisted space registry
// Tracks which spaces (issue keys) are "open" in Pappardelle.
// Previously, spaces were discovered by listing active tmux sessions,
// which meant they disappeared after a reboot or tmux server kill.
// This registry persists to disk so spaces survive across restarts.

import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const DEFAULT_REGISTRY_PATH = path.join(
	homedir(),
	'.pappardelle',
	'open-spaces.json',
);

let registryPath = DEFAULT_REGISTRY_PATH;
let cachedKeys: string[] | null = null;

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
	registryPath = DEFAULT_REGISTRY_PATH;
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
