import fs from 'node:fs';
import path from 'node:path';
import {isMainThread} from 'node:worker_threads';

// xo's ava rules load this file in a worker thread, where an exit listener
// never fires: the run tmpdir is only for the ava run itself.
if (isMainThread) {
	// Under /tmp rather than os.tmpdir(): on macOS that is a long
	// /var/folders path, and the sockets tests create under it would pass the
	// ~104-byte unix socket limit.
	const runTmpdir = fs.mkdtempSync('/tmp/ptr-');
	process.env.TMPDIR = runTmpdir;
	// A run started inside a space, or by a timer service, inherits that space's
	// PAPPARDELLE_*, and the state ones (PAPPARDELLE_STATE_DB,
	// PAPPARDELLE_STATUS_SOCKET, ...) point past any HOME at the real database.
	// A test run keeps only its state mode and its own PAPPARDELLE_TEST_* switches.
	for (const name of Object.keys(process.env)) {
		if (
			name.startsWith('PAPPARDELLE_') &&
			name !== 'PAPPARDELLE_SQLITE_STATE' &&
			!name.startsWith('PAPPARDELLE_TEST_')
		) {
			delete process.env[name];
		}
	}

	// These move the agents' config dirs off HOME, so they would point tests at
	// the developer's own Claude and Codex config.
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CODEX_HOME;

	// Bun reads HOME once at startup, so the throwaway HOME has to be in the
	// environment the workers are forked with. Everything under ~/.pappardelle
	// (logs, state, the status daemon's socket) and ~/.claude.json then lands
	// here for the workers and every process they start. Outside the run tmpdir,
	// so what tests leave in HOME doesn't count against its leak check.
	const throwawayHome = fs.mkdtempSync('/tmp/ph-');
	process.env.HOME = throwawayHome;
	process.env.PAPPARDELLE_TEST_HOME = throwawayHome;
	// Without a .zshrc, a zsh started in a test's tmux pane opens its first-run
	// wizard, which takes the keys the test types.
	fs.writeFileSync(path.join(throwawayHome, '.zshrc'), '');
	// Every git commit and fetch otherwise detaches a `git maintenance run
	// --auto`, which can still be writing into a test's repo after the test
	// removed it. Set through the environment rather than HOME's .gitconfig so it
	// also reaches the gits that tests start under a HOME of their own.
	process.env.GIT_CONFIG_COUNT = '1';
	process.env.GIT_CONFIG_KEY_0 = 'maintenance.auto';
	process.env.GIT_CONFIG_VALUE_0 = 'false';
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
		for (const dir of [runTmpdir, throwawayHome]) {
			fs.rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
		}
	});
	// On SIGTERM and SIGHUP Node exits at once, which orphans ava's workers to
	// keep writing into the run tmpdir after the exit listener removed it. Ava's
	// own SIGINT handling stops the workers before exiting.
	for (const signal of ['SIGTERM', 'SIGHUP']) {
		process.once(signal, () => {
			process.emit('SIGINT');
		});
	}
}

const config = {
	extensions: {
		ts: 'module',
		tsx: 'module',
	},
	require: [
		'./test/helpers/test-home-guard.ts',
		'./test/helpers/state-db-setup.ts',
	],
	workerThreads: false,
	timeout: '2m',
};

export default config;
