// Loaded into every test process (ava.config.js, require), so a worker
// started without the test tmux guard fails before any of
// its tests can reach the user's tmux servers.
import path from 'node:path';

if (Bun.which('tmux')) {
	const guardHome = process.env['PAPPARDELLE_TEST_TMUX_GUARD'];
	const tmuxTmpdir = process.env['TMUX_TMPDIR'];
	if (
		!guardHome ||
		Bun.which('tmux') !== path.join(guardHome, 'bin', 'tmux') ||
		process.env['TMUX'] !== undefined ||
		!tmuxTmpdir ||
		path.dirname(process.env['PAPPARDELLE_TEST_TMUX_REFUSALS'] ?? '') !==
			tmuxTmpdir
	) {
		throw new Error(
			`Tests are running without the test tmux guard (tmux on PATH: ${Bun.which('tmux')}, TMUX=${process.env['TMUX']}, TMUX_TMPDIR=${tmuxTmpdir}), so they could reach your own tmux servers. Run them with ava from the repository root.`,
		);
	}
}
