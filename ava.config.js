import fs from 'node:fs';
import {isMainThread} from 'node:worker_threads';

// xo's ava rules load this file in a worker thread, where an exit listener
// never fires: the run tmpdir is only for the ava run itself.
if (isMainThread) {
	// Under /tmp rather than os.tmpdir(): on macOS that is a long
	// /var/folders path, and the sockets tests create under it would pass the
	// ~104-byte unix socket limit.
	const runTmpdir = fs.mkdtempSync('/tmp/ptr-');
	process.env.TMPDIR = runTmpdir;
	process.on('exit', () => {
		// A failed, timed-out or interrupted run kills workers before their own
		// cleanup runs, so leftovers then say nothing about the tests.
		if (!process.exitCode) {
			const leftovers = fs.readdirSync(runTmpdir);
			if (leftovers.length > 0) {
				console.error(
					`Tests left ${leftovers.length} entries in their temp dir. Remove what a test creates, e.g. with tempDir(t, prefix) from test/helpers/temp-dir.ts:`,
				);
				for (const entry of leftovers) console.error(`  ${entry}`);
				process.exitCode = 1;
			}
		}

		// A status daemon a test started can still be writing as the run ends.
		fs.rmSync(runTmpdir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	});
}

const config = {
	extensions: {
		ts: 'module',
		tsx: 'module',
	},
	require: ['./test/helpers/state-db-setup.ts'],
	workerThreads: false,
	timeout: '2m',
};

export default config;
