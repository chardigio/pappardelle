import fs from 'node:fs';
import path from 'node:path';

/**
 * When a PR was last linked, on this machine, in any repo. `pappardelle
 * link-pr` runs in another process than the rail. Touching the stamp tells
 * every running rail that GitHub is reachable again, so a lookup that failed
 * earlier (say, before `gh auth login`) retries right away.
 */
export interface PrLinkStampDao {
	touch(): Promise<void>;
	/** The time of the last touch in milliseconds, or 0 when there was none. */
	read(): number;
}

export function prLinkStampPath(baseDir: string): string {
	return path.join(baseDir, 'pr-link.stamp');
}

export class JsonPrLinkStampDao implements PrLinkStampDao {
	constructor(
		private readonly file: string,
		private readonly clock: () => Date,
	) {}

	async touch(): Promise<void> {
		this.touchFile();
	}

	read(): number {
		try {
			return fs.statSync(this.file).mtimeMs;
		} catch {
			return 0;
		}
	}

	touchFile(): void {
		fs.mkdirSync(path.dirname(this.file), {recursive: true});
		fs.writeFileSync(this.file, `${this.clock().getTime()}\n`);
	}
}
