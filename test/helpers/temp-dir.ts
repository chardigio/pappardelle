import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {teardown} from './teardown.ts';

/**
 * Resolved through symlinks, since on macOS the temp dir is reached through
 * one and paths a subprocess reports back come out resolved.
 */
export function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	teardown(() => {
		// A daemon or child a test started can still be writing as it ends.
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	});
	return dir;
}
