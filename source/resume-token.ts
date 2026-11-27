// Imported first by every entry point, so Pappardelle never passes on the
// OSC 7577 token of the terminal it runs in: whatever it starts, the inner
// tmux server included, gets no token but the fresh one each pane is given.

// Bun.spawn with no env option passes the environment the process started
// with, deletion or not, so a spawn here always passes env.
const inherited = process.env['OSC7577_TOKEN'];
delete process.env['OSC7577_TOKEN'];

/** The token of the terminal Pappardelle runs in, for its own report. */
export function inheritedResumeToken(): string | undefined {
	return inherited || undefined;
}
