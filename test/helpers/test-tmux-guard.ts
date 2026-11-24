// Loaded into every test process (ava.config.js, require), so a worker
// started without the test tmux guard (docs/glossary.md) fails before any of
// its tests can reach the user's tmux servers.
if (Bun.which('tmux')) {
	const wrapper = `/tmp/pappardelle-test-tmux-${process.getuid!()}/bin/tmux`;
	if (
		Bun.which('tmux') !== wrapper ||
		process.env['TMUX'] !== undefined ||
		!process.env['TMUX_TMPDIR']?.startsWith('/tmp/pt-')
	) {
		throw new Error(
			`Tests are running without the test tmux guard (tmux on PATH: ${Bun.which('tmux')}, TMUX=${process.env['TMUX']}, TMUX_TMPDIR=${process.env['TMUX_TMPDIR']}), so they could reach your own tmux servers. Run them with ava from the repository root.`,
		);
	}
}
