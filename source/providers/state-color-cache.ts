// Persisted workflow state color cache
// Stores state name → hex color mappings in memory and on disk so the
// main worktree color works even when no active issue has that state.
//
// Cache files are namespaced per-repo under ~/.pappardelle/repos/{repoName}/
// when initStateColorCacheDir() is called on startup.
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const LEGACY_CACHE_PATH = path.join(
	homedir(),
	'.pappardelle',
	'state-colors.json',
);

let overrideCacheDir: string | null = null;

/**
 * Initialize the state color cache directory for a specific repo.
 * Sets the default cache path so new StateColorCache() instances use it.
 * Migrates legacy ~/.pappardelle/state-colors.json if present.
 */
export function initStateColorCacheDir(
	repoDir: string,
	baseDir?: string,
): void {
	overrideCacheDir = repoDir;

	const repoPath = path.join(repoDir, 'state-colors.json');
	const legacyPath = baseDir
		? path.join(baseDir, 'state-colors.json')
		: LEGACY_CACHE_PATH;

	if (fs.existsSync(legacyPath)) {
		try {
			if (!fs.existsSync(repoPath)) {
				fs.mkdirSync(repoDir, {recursive: true});
				fs.renameSync(legacyPath, repoPath);
			} else {
				fs.unlinkSync(legacyPath);
			}
		} catch {
			// Non-critical — will retry on next startup
		}
	}
}

/**
 * Reset to default path (for testing cleanup).
 */
export function resetStateColorCacheDir(): void {
	overrideCacheDir = null;
}

function getDefaultCachePath(): string {
	if (overrideCacheDir) {
		return path.join(overrideCacheDir, 'state-colors.json');
	}

	return LEGACY_CACHE_PATH;
}

export class StateColorCache {
	private readonly map = new Map<string, string>();
	private readonly cachePath: string;

	constructor(cachePath?: string) {
		this.cachePath = cachePath ?? getDefaultCachePath();
		this.loadFromDisk();
	}

	get(name: string): string | null {
		return this.map.get(name) ?? null;
	}

	/**
	 * Update a state color. Persists to disk only when the value changes.
	 */
	update(name: string, color: string): void {
		if (this.map.get(name) === color) return;
		this.map.set(name, color);
		this.persistToDisk();
	}

	private loadFromDisk(): void {
		try {
			const data = fs.readFileSync(this.cachePath, 'utf-8');
			const colors = JSON.parse(data) as Record<string, string>;
			for (const [name, color] of Object.entries(colors)) {
				if (typeof name === 'string' && typeof color === 'string') {
					this.map.set(name, color);
				}
			}
		} catch {
			// File doesn't exist yet or is invalid — start with empty map
		}
	}

	private persistToDisk(): void {
		try {
			const dir = path.dirname(this.cachePath);
			fs.mkdirSync(dir, {recursive: true});
			const colors = Object.fromEntries(this.map);
			fs.writeFileSync(this.cachePath, JSON.stringify(colors) + '\n');
		} catch {
			// Non-critical — colors will be re-discovered on next issue fetch
		}
	}
}
