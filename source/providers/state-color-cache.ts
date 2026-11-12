// Persisted workflow state color cache
// Stores state name → hex color mappings in memory and on disk so the
// main worktree color works even when no active issue has that state.
//
// Cache files are namespaced per-repo under ~/.pappardelle/repos/{repoName}/.
import fs from 'node:fs';
import path from 'node:path';
import {createLogger} from '../logger.ts';

const log = createLogger('state-colors');

export function getStateColorsPath(repoName: string, baseDir: string): string {
	return path.join(baseDir, 'repos', repoName, 'state-colors.json');
}

/**
 * Move the cache from its pre-repo-namespacing path, the first time a repo
 * runs with the per-repo layout.
 */
export function migrateLegacyStateColors(
	repoName: string,
	baseDir: string,
): void {
	const repoPath = getStateColorsPath(repoName, baseDir);
	const legacyPath = path.join(baseDir, 'state-colors.json');

	if (fs.existsSync(legacyPath)) {
		try {
			if (!fs.existsSync(repoPath)) {
				fs.mkdirSync(path.dirname(repoPath), {recursive: true});
				fs.renameSync(legacyPath, repoPath);
			} else {
				fs.unlinkSync(legacyPath);
			}
		} catch {
			// Non-critical — will retry on next startup
		}
	}
}

/** The colors in a cache file. Throws when it is not JSON. */
export function parseStateColors(content: string): Map<string, string> {
	const colors = new Map<string, string>();
	const parsed = JSON.parse(content) as Record<string, unknown>;
	for (const [name, color] of Object.entries(parsed)) {
		if (typeof color === 'string') colors.set(name, color);
	}

	return colors;
}

/** A cache file's content for these colors. */
export function renderStateColors(
	colors: Iterable<readonly [string, string]>,
): string {
	return JSON.stringify(Object.fromEntries(colors)) + '\n';
}

/** One repo's workflow state colors, as kept between runs. */
export interface StateColorDao {
	load(): Record<string, string>;
	set(name: string, color: string): Promise<void>;
}

/**
 * The colors as one JSON file per repo, rewritten whole from what this
 * process loaded and has set since.
 */
export class JsonStateColorDao implements StateColorDao {
	private colors = new Map<string, string>();

	constructor(readonly file: string) {}

	load(): Record<string, string> {
		try {
			this.colors = parseStateColors(fs.readFileSync(this.file, 'utf-8'));
		} catch {
			// File doesn't exist yet or is invalid — start with empty map
		}

		return Object.fromEntries(this.colors);
	}

	async set(name: string, color: string): Promise<void> {
		this.colors.set(name, color);
		try {
			fs.mkdirSync(path.dirname(this.file), {recursive: true});
			fs.writeFileSync(this.file, renderStateColors(this.colors));
		} catch {
			// Non-critical — colors will be re-discovered on next issue fetch
		}
	}
}

export class StateColorCache {
	private readonly map: Map<string, string>;

	/** Without a store the colors last as long as the process. */
	constructor(private readonly dao?: StateColorDao) {
		this.map = new Map(Object.entries(dao?.load() ?? {}));
	}

	get(name: string): string | null {
		return this.map.get(name) ?? null;
	}

	/**
	 * Update a state color. Persists it only when the value changes.
	 */
	update(name: string, color: string): void {
		if (this.map.get(name) === color) return;
		this.map.set(name, color);
		this.dao?.set(name, color).catch((error: unknown) => {
			// Colors are re-discovered on the next issue fetch.
			log.warn(
				`Could not store the color of state ${name}`,
				error instanceof Error ? error : undefined,
			);
		});
	}
}
