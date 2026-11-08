import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

// `pappardelle link-pr` runs in another process than the rail. Touching this
// file tells every running rail that GitHub is reachable again, so a lookup
// that failed earlier (say, before `gh auth login`) retries right away.
function stampPath(baseDir?: string) {
	return path.join(
		baseDir ?? path.join(homedir(), '.pappardelle'),
		'pr-link.stamp',
	);
}

export function touchPrLinkStamp(baseDir?: string): void {
	const file = stampPath(baseDir);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file, `${Date.now()}\n`);
}

export function readPrLinkStamp(baseDir?: string): number {
	try {
		return fs.statSync(stampPath(baseDir)).mtimeMs;
	} catch {
		return 0;
	}
}
