import type {ProgramStatusSnapshot} from './program-status-monitor.ts';

/**
 * One repo's snapshots by space key, then pane generation. A space can hold
 * more than one for a moment: its agent pane was replaced, and the old pane's
 * snapshot stays until the new pane's monitor is attached.
 */
export class SnapshotIndex {
	private readonly spaces = new Map<
		string,
		Map<string, ProgramStatusSnapshot>
	>();

	get(key: string, generation: string): ProgramStatusSnapshot | undefined {
		return this.spaces.get(key)?.get(generation);
	}

	keep(snapshot: ProgramStatusSnapshot): void {
		const generations = this.spaces.get(snapshot.key) ?? new Map();
		generations.set(snapshot.pane.generation, snapshot);
		this.spaces.set(snapshot.key, generations);
	}

	/** Drop the snapshots of a space, except pane generation `keep`'s. */
	forget(key: string, keep?: string): void {
		const generations = this.spaces.get(key);
		for (const generation of generations?.keys() ?? []) {
			if (generation !== keep) generations!.delete(generation);
		}
	}

	keys(): string[] {
		return [...this.spaces.keys()];
	}

	all(): ProgramStatusSnapshot[] {
		return [...this.spaces.values()].flatMap(generations => [
			...generations.values(),
		]);
	}
}
