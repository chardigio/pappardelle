import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The part of an ava test context the test helpers use. */
export type Teardown = {teardown(fn: () => void | Promise<void>): unknown};

/**
 * Resolved through symlinks, since on macOS the temp dir is reached through
 * one and paths a subprocess reports back come out resolved.
 */
export function tempDir(t: Teardown, prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	t.teardown(() => {
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
