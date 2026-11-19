// Which terminal backend Pappardelle drives.
//
// There are three programs that can hold Pappardelle's panes, and the code
// supports all three. The choice is made once per process:
//
//   backend: tmux | herdr | herdr-app     in .pappardelle.yml, or
//   PAPPARDELLE_BACKEND                   in the environment (wins, per run).
//
// The default is tmux, so nothing changes for anyone who has not asked.
//
// What each backend owns:
//
//   tmux        sessions (agent/companion) and the pane layout; a pane is a
//               viewer running `tmux attach`, repointed with `switch-client`
//   herdr       the `herdr` CLI's workspaces and panes; a pane is a viewer
//               running `hc attach`, repointed by typing a new attach
//   herdr-app   the Herdr desktop window; a pane *is* a terminal, and the
//               window's own space/tab selection shows the right one
//
// The third is not a variant of the second: the desktop app has a different
// pane model (panes own terminals; `terminal.show` does not repoint one), so
// switching spaces there means selecting a space's tab, not attaching.

export type TerminalBackendName = 'tmux' | 'herdr' | 'herdr-app';

/** The backend names a config may use, with the aliases people try. */
const ALIASES: Record<string, TerminalBackendName> = {
	tmux: 'tmux',
	herdr: 'herdr',
	'herdr-core': 'herdr',
	hc: 'herdr',
	'herdr-app': 'herdr-app',
	'herdr-desktop': 'herdr-app',
	'herdr desktop': 'herdr-app',
	desktop: 'herdr-app',
};

export type BackendSelection = {
	name: TerminalBackendName;
	/** Why it was chosen, for the log line and the startup trace. */
	source: 'config' | 'env' | 'default';
};

export function parseBackendName(
	value: string | undefined,
): TerminalBackendName | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return ALIASES[normalized] ?? null;
}

/** Every name a config may use for a backend, for the error message. */
export const BACKEND_NAMES: readonly TerminalBackendName[] = [
	'tmux',
	'herdr',
	'herdr-app',
];

/**
 * Pick the backend. The environment wins so a single run can try one without
 * editing a repo's config; otherwise the config's `backend:` decides;
 * otherwise tmux.
 */
export function selectBackend(
	options: {
		env?: NodeJS.ProcessEnv;
		configured?: string | undefined;
	} = {},
): BackendSelection {
	const env = options.env ?? process.env;
	const fromEnv = parseBackendName(env['PAPPARDELLE_BACKEND']);
	if (fromEnv) return {name: fromEnv, source: 'env'};

	const fromConfig = parseBackendName(options.configured);
	if (fromConfig) return {name: fromConfig, source: 'config'};

	return {name: 'tmux', source: 'default'};
}

/** True when herdr-core runs the terminals (the CLI or desktop backend). */
export function backendUsesCore(selection: BackendSelection): boolean {
	return selection.name === 'herdr' || selection.name === 'herdr-app';
}

/**
 * True when the desktop window owns the panes, so the TUI neither splits panes
 * nor runs an attach viewer.
 */
export function backendIsDesktop(selection: BackendSelection): boolean {
	return selection.name === 'herdr-app';
}

/**
 * The command a viewer pane runs to show a space's terminal under the `herdr`
 * CLI. Mirrors `nestedAttachCommand` in tmux.ts, which runs `tmux attach`.
 * Unused by the desktop backend, where a pane is its terminal already.
 */
export function herdrAttachCommand(terminalName: string): string {
	return `hc attach ${quoteArg(terminalName)}`;
}

function quoteArg(value: string): string {
	if (/^[\w./:@%+=-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
