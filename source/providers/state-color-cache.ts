// Persisted workflow state color cache
// Stores state name → hex color mappings in memory and on disk so the
// main worktree color works even when no active issue has that state.
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const DEFAULT_CACHE_PATH = path.join(
	homedir(),
	'.pappardelle',
	'state-colors.json',
);

export class StateColorCache {
	private readonly map = new Map<string, string>();
	private readonly cachePath: string;

	constructor(cachePath?: string) {
		this.cachePath = cachePath ?? DEFAULT_CACHE_PATH;
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
