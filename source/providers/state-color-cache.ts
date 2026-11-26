// Workflow state colors: state name to hex color, kept in memory and in the
// state database so the main worktree color works even when no active issue
// has that state.
import path from 'node:path';
import {createLogger} from '../logger.ts';

const log = createLogger('state-colors');

export function getStateColorsPath(repoName: string, baseDir: string): string {
	return path.join(baseDir, 'repos', repoName, 'state-colors.json');
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

/** One repo's workflow state colors, as kept between runs. */
export interface StateColorDao {
	load(): Record<string, string>;
	set(name: string, color: string): Promise<void>;
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
