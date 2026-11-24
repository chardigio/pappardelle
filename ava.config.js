import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMainThread} from 'node:worker_threads';
import {isHostPappardelleEnv} from './test/helpers/env.ts';

// xo's ava rules load this file in a worker thread, where an exit listener
// never fires: the run tmpdir is only for the ava run itself.
if (isMainThread) {
	// The test tmux guard (docs/glossary.md): tests and everything they start
	// get a tmux that refuses the user's own servers, a private TMUX_TMPDIR and
	// no TMUX. A test that reached the inner server once ended every agent
	// session the user had open.
	const tmuxGuardEnv = execFileSync(
		fileURLToPath(new URL('test/helpers/tmux-guard-env.sh', import.meta.url)),
		{encoding: 'utf8'},
	);
	for (const line of tmuxGuardEnv.split('\n')) {
		const exported = /^export (\w+)='(.*)'$/.exec(line);
		if (exported) {
			process.env[exported[1]] = exported[2].replaceAll(`'\\''`, "'");
		} else if (line.startsWith('unset ')) {
			for (const name of line.split(' ').slice(1)) delete process.env[name];
		}
	}

	const guardedTmuxTmpdir = tmuxGuardEnv ? process.env.TMUX_TMPDIR : undefined;
	const sharedRefusals = path.join(
		process.env.PAPPARDELLE_TEST_TMUX_GUARD ?? '',
		'refusals.log',
	);
	const sharedRefusalsStart = fs.existsSync(sharedRefusals)
		? fs.statSync(sharedRefusals).size
		: 0;
	const refusals = () => {
		if (!guardedTmuxTmpdir) return [];
		const read = (file, start) =>
			fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(start) : '';
		return [
			read(process.env.PAPPARDELLE_TEST_TMUX_REFUSALS, 0),
			read(sharedRefusals, sharedRefusalsStart),
		]
			.join('')
			.split('\n')
			.filter(Boolean);
	};

	// Under /tmp rather than os.tmpdir(): on macOS that is a long
	// /var/folders path, and the sockets tests create under it would pass the
	// ~104-byte unix socket limit.
	const runTmpdir = fs.mkdtempSync('/tmp/ptr-');
	process.env.TMPDIR = runTmpdir;
	for (const name of Object.keys(process.env)) {
		if (isHostPappardelleEnv(name)) delete process.env[name];
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

		// Unlike leftovers, a refusal fails even a run that already failed: the
		// test that made it would have killed the user's tmux sessions.
		const refused = refusals();
		if (refused.length > 0) {
			console.error(
				`The test tmux guard refused ${refused.length} tmux calls against the live tmux directory (docs/glossary.md). Give each test its own TMUX_TMPDIR or a -S socket:`,
			);
			for (const line of refused) console.error(`  ${line}`);
			process.exitCode = 1;
		}

		if (guardedTmuxTmpdir) {
			const sockets = fs
				.readdirSync(guardedTmuxTmpdir, {recursive: true})
				.map(entry => path.join(guardedTmuxTmpdir, entry))
				.filter(entry =>
					fs.lstatSync(entry, {throwIfNoEntry: false})?.isSocket(),
				);
			for (const socket of sockets) {
				try {
					execFileSync('tmux', ['-S', socket, 'kill-server'], {
						stdio: 'ignore',
					});
				} catch {}
			}
		}

		// A status daemon a test started can still be writing as the run ends.
		for (const dir of [runTmpdir, throwawayHome, guardedTmuxTmpdir]) {
			if (!dir) continue;
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
		'./test/helpers/test-tmux-guard.ts',
		'./test/helpers/state-db-setup.ts',
	],
	workerThreads: false,
	timeout: '2m',
};

export default config;
