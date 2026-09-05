// Tmux session attachment for pappardelle
// Attaches to existing claude-STA-XXX and companion-STA-XXX sessions created by idow
import {exec, execSync, spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
import {
	DEFAULT_COMPANION_COMMAND,
	getClaudeEffort,
	getClaudeModel,
	getCompanionCommand,
	getDangerouslySkipPermissions,
	getRepoName,
	loadConfig,
} from './config.ts';
import {createLogger} from './logger.ts';
import {getRegisteredSpaces} from './space-registry.ts';
import {isSimctlUnavailableError} from './simctl-check.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	MIN_COMPANION_WIDTH,
	NARROW_SCREEN_THRESHOLD,
	type LayoutConfig,
} from './layout-sizing.ts';
import {nextRailWidthOverride, type WindowSize} from './rail-width.ts';

// Re-export sizing constants and functions for external use
export {
	calculateIdealListHeightForCount,
	calculateLayoutForSize,
	NARROW_SCREEN_THRESHOLD,
	MIN_LIST_WIDTH,
	MIN_CLAUDE_WIDTH,
	MIN_COMPANION_WIDTH,
	MIN_RAIL_OVERRIDE_WIDTH,
	MAX_LIST_HEIGHT,
	DEFAULT_MIN_LIST_HEIGHT,
	type LayoutConfig,
} from './layout-sizing.ts';

const log = createLogger('tmux');

// Dedicated tmux socket for per-issue claude/companion sessions. The root
// `pappardelle-{repo}` session and its layout panes stay on the default
// socket; everything the viewer panes attach to lives here. Routing inner
// sessions onto a distinct socket lets the nested attach succeed without
// `TMUX=`, which in turn lets `$TMUX` propagate correctly to subprocesses
// like Claude Code's Agent Teams feature. Must match PAPPARDELLE_TMUX_SOCKET
// in _dev/scripts/dow/*.sh — the two sides have to agree.
export const INNER_SOCKET = 'pappardelle_inner';

/**
 * Prefix `['-L', INNER_SOCKET, ...]` onto a tmux argv. Every inner-session
 * call site must route through this helper so the -L flag can't be forgotten.
 */
export function innerTmuxArgs(args: readonly string[]): string[] {
	return ['-L', INNER_SOCKET, ...args];
}

// Session naming convention (matches idow)
// Sessions are repo-qualified: claude-{repoName}-{key}, e.g. claude-pappa-chex-CHEX-313

/**
 * Get the session prefix for a given type and repo name.
 * e.g. getSessionPrefix('claude', 'pappa-chex') → 'claude-pappa-chex-'
 */
export function getSessionPrefix(
	type: 'claude' | 'companion',
	repoName?: string,
): string {
	const repo = repoName ?? getRepoName();
	return `${type}-${repo}-`;
}

/**
 * Extract the space key from a repo-qualified session name.
 * e.g. extractIssueKeyFromSession('claude-pappa-chex-CHEX-313', 'pappa-chex') → 'CHEX-313'
 * Returns null if the session doesn't match the expected prefix.
 */
export function extractIssueKeyFromSession(
	sessionName: string,
	repoName?: string,
): string | null {
	const prefix = getSessionPrefix('claude', repoName);
	if (!sessionName.startsWith(prefix)) return null;
	return fromSessionKey(sessionName.slice(prefix.length));
}

// Track which space is currently being viewed
let currentlyViewingSpace: string | null = null;

// Track if panes have active nested tmux clients (vs just shell)
let claudeViewerHasClient = false;
let companionViewerHasClient = false;

// Cache pane TTYs for fast client switching
let claudeViewerTty: string | null = null;
let companionViewerTty: string | null = null;

/**
 * Ticket-rail width the user set by hand, or null while the derived width
 * still applies.
 *
 * Module state on purpose: STA-2040 asks for the choice to hold for the rest of
 * the session and for every new pappardelle to open at the default, and process
 * lifetime is exactly that. `rebuildLayout` must not clear it, because crossing
 * the narrow/wide threshold and coming back is not the user changing their mind.
 */
let railWidthOverride: number | null = null;

/**
 * Window size and measured rail width at the end of the previous relayout.
 *
 * Together they let `nextRailWidthOverride` separate a window resize from a
 * hand-drag of the rail/claude border. Measured, not requested, so tmux
 * rounding never reads as a drag.
 */
let lastWindowSize: WindowSize | null = null;
let lastRailWidth: number | null = null;

/**
 * Check if running inside tmux
 */
export function isInTmux(): boolean {
	return Boolean(process.env['TMUX']);
}

/**
 * Check if a tmux session exists on the default socket. Used for the outer
 * `pappardelle-{repo}` session. Do not call for per-issue claude/companion
 * sessions — those live on the inner socket; use `innerSessionExists` instead.
 */
export function sessionExists(sessionName: string): boolean {
	try {
		execSync(`tmux has-session -t "${sessionName}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a per-issue tmux session exists on the inner socket
 * (`tmux -L pappardelle_inner`).
 */
export function innerSessionExists(sessionName: string): boolean {
	try {
		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['has-session', '-t', sessionName]),
			{
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

export function toSessionKey(issueKey: string): string {
	return issueKey.replaceAll('_', '__').replaceAll('.', '_');
}

export function fromSessionKey(sessionKey: string): string {
	return sessionKey.replaceAll(/__|_/g, match => (match === '__' ? '_' : '.'));
}

/**
 * Get session names for a space.
 * Optional repoName parameter for testing; defaults to getRepoName().
 */
export function getSessionNames(
	issueKey: string,
	repoName?: string,
): {
	claude: string;
	companion: string;
} {
	const claudePrefix = getSessionPrefix('claude', repoName);
	const companionPrefix = getSessionPrefix('companion', repoName);
	const key = toSessionKey(issueKey);
	return {
		claude: `${claudePrefix}${key}`,
		companion: `${companionPrefix}${key}`,
	};
}

/**
 * Single-quote a string for safe use as a shell argument. Wraps the value in
 * single quotes and escapes any embedded single quotes via the classic
 * `'\''` trick.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pass-through flags resolved from the `claude:` config block (top-level or
 * per-profile). An empty/absent value means "don't pass the flag at all", which
 * is what keeps the launch command byte-identical for configs that never
 * mention model or effort.
 */
export interface ClaudeLaunchOptions {
	model?: string;
	effort?: string;
}

/**
 * Render a `--flag value` pair for the claude command line, or '' when the
 * value is unset. Values come from user config, so anything that isn't a bare
 * token gets single-quoted (model ids like `claude-opus-5[1m]` contain glob
 * characters the shell would otherwise try to expand).
 */
function claudeFlag(flag: string, value?: string): string {
	if (!value) return '';
	const safe = /^[A-Za-z0-9._-]+$/.test(value) ? value : shellQuote(value);
	return ` ${flag} ${safe}`;
}

// No `-F`: it would let the pager exit on its own for output that fits the
// popup, which is exactly the flash-and-vanish this pager exists to prevent.
const POPUP_PAGER = 'less -R';

/**
 * Show a command's output in a dismissible tmux popup over the current client.
 * Used by trackers whose issues have no web page to open: beads keeps
 * everything local, so `o` renders `bd show` here instead of launching a
 * browser. Runs on the outer socket, where the TUI's own client lives.
 *
 * Detached like the other `o`-key launchers (`open`, `cursor`): the popup owns
 * the terminal until the user dismisses it, and waiting on it here would stall
 * Ink's render loop. `argv` is quoted rather than interpolated because
 * display-popup takes a shell command string, not an argument vector.
 * Returns false when there's no tmux client to draw over.
 *
 * The output goes through a pager because `-E` tears the popup down the moment
 * the command exits, and the commands worth showing here print and exit
 * immediately, and without it the popup flashes for a frame. The pager also makes
 * an issue body taller than the popup scrollable instead of truncated.
 */
export function buildPopupCommand(argv: string[]): string {
	return `${argv.map(arg => shellQuote(arg)).join(' ')} | ${POPUP_PAGER}`;
}

export function displayPopup(argv: string[]): boolean {
	if (argv.length === 0 || !process.env['TMUX']) return false;
	const command = buildPopupCommand(argv);
	try {
		const child = spawn(
			'tmux',
			['display-popup', '-E', '-w', '80%', '-h', '80%', command],
			{detached: true, stdio: 'ignore'},
		);

		// A tmux that isn't on this process's PATH surfaces asynchronously, after
		// the try block has already returned success. With no listener Node
		// rethrows it and takes the whole TUI down over a popup that didn't open,
		// so swallow it the way launchBrowser does — the worst case is a popup the
		// user can see for themselves never appeared.
		child.on('error', () => {});
		child.unref();
		return true;
	} catch (error) {
		log.debug(`display-popup failed: ${String(error)}`);
		return false;
	}
}

/**
 * Build the shell command for starting Claude with --continue fallback.
 * Tries to resume the most recent conversation in the worktree directory,
 * falling back to bare claude if no prior conversation exists.
 * The ANSI escape clears the "No conversation found" error line on failure.
 *
 * `--name <issueKey>` is included on both branches so the session shows up
 * under the issue key in `/resume` and in the terminal title.
 *
 * Flag order (`--dangerously-skip-permissions --model --effort --name`) is
 * mirrored by start-claude-session.sh; keep the two in sync so a session
 * created by the TUI and one created by idow are indistinguishable.
 */
export function buildClaudeResumeCommand(
	issueKey: string,
	skipPermissions = false,
	launch: ClaudeLaunchOptions = {},
): string {
	const safeKey = /^[A-Za-z0-9._-]+$/.test(issueKey)
		? issueKey
		: shellQuote(issueKey);
	const base = skipPermissions
		? 'claude --dangerously-skip-permissions'
		: 'claude';
	const claudeCmd = `${base}${claudeFlag('--model', launch.model)}${claudeFlag(
		'--effort',
		launch.effort,
	)} --name ${safeKey}`;
	return `${claudeCmd} --continue || { printf '\\033[A\\033[2K'; false; } || ${claudeCmd}`;
}

/**
 * Check if sessions exist for a space (created by idow).
 * Queries the inner socket since per-issue sessions live there.
 */
export function spaceHasSessions(issueKey: string): {
	claude: boolean;
	companion: boolean;
} {
	const names = getSessionNames(issueKey);
	return {
		claude: innerSessionExists(names.claude),
		companion: innerSessionExists(names.companion),
	};
}

/**
 * List all claude sessions for this repo (claude-{repoName}-*)
 * on the inner socket.
 */
export function listClaudeSessions(): string[] {
	try {
		const prefix = getSessionPrefix('claude');
		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['list-sessions', '-F', '#{session_name}']),
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return [];
		}

		return result.stdout
			.trim()
			.split('\n')
			.filter(name => name.startsWith(prefix));
	} catch {
		return [];
	}
}

/**
 * Get the TTY device for a pane
 * This is used to identify the nested tmux client running in a viewer pane
 */
function getPaneTty(paneId: string): string | null {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{pane_tty}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return null;
		}
		return result.stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Check if a tmux client exists on a given TTY.
 * Nested clients created by the viewer-pane attach live on the inner socket,
 * so list-clients must target that socket.
 */
function clientExistsOnTty(tty: string): boolean {
	try {
		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['list-clients', '-F', '#{client_tty}']),
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);
		if (result.error || result.status !== 0) {
			return false;
		}
		const clients = result.stdout.trim().split('\n');
		return clients.includes(tty);
	} catch {
		return false;
	}
}

/**
 * Switch a tmux client to a different session.
 * The client lives on the inner socket (it was created by our `tmux -L
 * pappardelle_inner attach …`), and switch-client can only move a client
 * between sessions on the *same* socket — which is fine because every
 * per-issue session also lives on the inner socket.
 */
function switchClientToSession(
	clientTty: string,
	sessionName: string,
): boolean {
	try {
		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['switch-client', '-c', clientTty, '-t', sessionName]),
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			log.error(
				`Failed to switch client ${clientTty} to ${sessionName}: ${result.stderr}`,
			);
			return false;
		}
		log.debug(`Switched client ${clientTty} to session ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to switch client to session`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill a tmux session by name on the default socket.
 * Used for the outer `pappardelle-{repo}` session on Pappardelle quit.
 */
export function killSession(sessionName: string): boolean {
	try {
		if (!sessionExists(sessionName)) {
			log.debug(`Session ${sessionName} does not exist, nothing to kill`);
			return true;
		}

		execSync(`tmux kill-session -t "${sessionName}"`, {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log.info(`Killed session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to kill session ${sessionName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill a tmux session by name on the inner socket. Used for per-issue
 * claude/companion sessions.
 */
export function innerKillSession(sessionName: string): boolean {
	try {
		if (!innerSessionExists(sessionName)) {
			log.debug(`Inner session ${sessionName} does not exist, nothing to kill`);
			return true;
		}

		const result = spawnSync(
			'tmux',
			innerTmuxArgs(['kill-session', '-t', sessionName]),
			{
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		if (result.error || result.status !== 0) {
			log.error(
				`Failed to kill inner session ${sessionName}: ${result.stderr}`,
			);
			return false;
		}
		log.info(`Killed inner session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to kill inner session ${sessionName}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Minimal runner surface for `cleanupOrphanedOuterSessions`. Exposed so tests
 * can inject a fake tmux without spawning real processes. The default runner
 * shells out via `spawnSync`.
 */
export type OuterTmuxRunner = (args: readonly string[]) => {
	error?: Error;
	status: number | null;
	stdout: string;
};

const defaultOuterTmuxRunner: OuterTmuxRunner = args => {
	const r = spawnSync('tmux', [...args], {
		encoding: 'utf-8',
		timeout: 5000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return {
		error: r.error,
		status: r.status,
		stdout: r.stdout ?? '',
	};
};

/**
 * Kill any leftover `claude-{repo}-*` and `companion-{repo}-*` sessions still
 * living on the default tmux socket from a pre-STA-860 Pappardelle run. They
 * can't be migrated (tmux doesn't move sessions between servers), so we drop
 * them and let idow/Pappardelle recreate them on the inner socket.
 *
 * Intentionally targets the default socket (no `-L pappardelle_inner`) and
 * uses bare `kill-session` — this is the one inner-session-name operation
 * that must not route through `innerKillSession`. See STA-860.
 *
 * Returns the number of sessions killed.
 *
 * `runner` is exposed for tests only; production always uses the spawnSync
 * default.
 */
export function cleanupOrphanedOuterSessions(
	repoName?: string,
	runner: OuterTmuxRunner = defaultOuterTmuxRunner,
): number {
	try {
		const claudePrefix = getSessionPrefix('claude', repoName);
		const companionPrefix = getSessionPrefix('companion', repoName);
		// Pre-STA-1464 the companion pane was named `lazygit-{repo}-*`. Sweep that
		// legacy prefix too so an upgrade doesn't strand old git-UI sessions.
		const repo = repoName ?? getRepoName();
		const legacyCompanionPrefix = `lazygit-${repo}-`;

		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) {
			return 0;
		}

		const orphans = result.stdout
			.trim()
			.split('\n')
			.filter(
				name =>
					name.startsWith(claudePrefix) ||
					name.startsWith(companionPrefix) ||
					name.startsWith(legacyCompanionPrefix),
			);

		let killed = 0;
		for (const name of orphans) {
			const k = runner(['kill-session', '-t', name]);
			if (!k.error && k.status === 0) {
				killed++;
				log.info(`Killed orphaned outer-socket session: ${name}`);
			}
		}
		return killed;
	} catch {
		return 0;
	}
}

/**
 * Inner-socket runner: routes through `innerTmuxArgs` so calls hit
 * `tmux -L pappardelle_inner`. Same shape as `OuterTmuxRunner` so
 * `cleanupOrphanedInnerSessions` can share the injectable-runner test
 * harness without duplicating the fake-runner plumbing.
 */
const defaultInnerTmuxRunner: OuterTmuxRunner = args => {
	const r = spawnSync('tmux', innerTmuxArgs(args), {
		encoding: 'utf-8',
		timeout: 5000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return {
		error: r.error,
		status: r.status,
		stdout: r.stdout ?? '',
	};
};

/**
 * DEC 2026 "synchronized output": the terminal buffers everything between
 * `ESC [ ? 2026 h` and `ESC [ ? 2026 l` and presents it as one frame.
 */
export const SYNC_TERMINAL_FEATURE = '*:Sync';

/**
 * Whether this socket's `terminal-features` already carries our Sync entry.
 *
 * `-v` prints one array entry per line with no `name[i]` prefix, so a whole-line
 * comparison is the array-element test; a substring search would confuse us with
 * a different terminal pattern that happens to name the same feature. Any
 * failure reports "absent": a duplicate entry is cosmetic, a missing one brings
 * the flicker back.
 */
function hasSynchronizedOutputFeature(run: OuterTmuxRunner): boolean {
	try {
		const {error, status, stdout} = run([
			'show-options',
			'-gqv',
			'terminal-features',
		]);
		if (error || status !== 0) {
			return false;
		}

		return stdout
			.split('\n')
			.some(line => line.trim() === SYNC_TERMINAL_FEATURE);
	} catch {
		return false;
	}
}

/**
 * Make tmux batch each repaint into a single atomic frame.
 *
 * tmux only wraps a redraw in DEC 2026 when it believes the attached client's
 * terminal supports Sync, and it decides that from the client's TERM. Our panes
 * routinely run clients whose TERM is `tmux-256color`, which advertises no
 * Sync. That is the normal shape here: the claude and companion panes each host
 * a nested `tmux -L pappardelle_inner attach`, so the client is attached from
 * inside another tmux. tmux then streams every repaint out unbatched,
 * so the outer terminal can present a half-drawn frame. That is the flicker seen
 * while typing, worst when the zoomed list pane repaints full-screen per
 * keystroke.
 *
 * `terminal-features` is server-scope; tmux offers no session or window scope
 * for it, so on the outer socket this necessarily touches the whole tmux server.
 * Two things keep that safe: we append (`-ga`) instead of assigning, so any
 * user-configured features survive, and terminals that don't implement DEC 2026
 * ignore the private mode, which is what makes the blanket `*` workable.
 *
 * The append is also guarded by a presence check. The tmux server outlives any
 * one Pappardelle run, so an unconditional `-ga` piles on another copy of the
 * entry per launch.
 *
 * Runners are exposed for tests only; production uses the spawnSync defaults.
 */
export function enableSynchronizedOutput(
	outerRunner: OuterTmuxRunner = defaultOuterTmuxRunner,
	innerRunner: OuterTmuxRunner = defaultInnerTmuxRunner,
): void {
	for (const [label, run] of [
		['outer', outerRunner],
		['inner', innerRunner],
	] as const) {
		try {
			if (hasSynchronizedOutputFeature(run)) {
				continue;
			}

			const {error, status} = run([
				'set-option',
				'-ga',
				'terminal-features',
				`,${SYNC_TERMINAL_FEATURE}`,
			]);
			if (error || status !== 0) {
				log.debug(`Could not enable synchronized output on ${label} socket`);
			}
		} catch {
			// Purely a rendering nicety — never let it break layout setup.
		}
	}
}

/**
 * STA-1420 layer 2: reap orphaned `claude-{repo}-*` / `companion-{repo}-*`
 * (and legacy `lazygit-{repo}-*`) sessions on the inner socket whose key is
 * neither in the registry nor the
 * main worktree (`'main'`). Symmetric to `cleanupOrphanedOuterSessions` but
 * for inner-socket leftovers — these accumulate when Pappardelle is hard-quit
 * (SIGKILL, terminal close, Ctrl-C during a slow `pre_workspace_deinit`)
 * between unregistering and killing. STA-1416 removed the `seedFromTmux`
 * resurrection helper that used to mop these up as a side effect, so without
 * this reaper they'd linger forever on the inner socket.
 *
 * Conservative on purpose: only kills sessions whose key is missing from the
 * registry AND isn't `MAIN_WORKTREE_KEY`. The main worktree row in app.tsx
 * uses the same constant, so its sessions (`claude-{repo}-main`,
 * `companion-{repo}-main`) are legitimate but never appear in the registry —
 * the constant keeps the "never reap main" coupling explicit on both sides.
 *
 * `runner` is exposed for tests only; production uses the spawnSync default.
 */
export function cleanupOrphanedInnerSessions(
	registeredKeys: Set<string>,
	repoName?: string,
	runner: OuterTmuxRunner = defaultInnerTmuxRunner,
): number {
	try {
		const claudePrefix = getSessionPrefix('claude', repoName);
		const companionPrefix = getSessionPrefix('companion', repoName);
		// Pre-STA-1464 the companion pane was named `lazygit-{repo}-*`. Reap that
		// legacy prefix too so a hard-quit straddling an upgrade doesn't strand old
		// git-UI sessions on the inner socket. Mirrors cleanupOrphanedOuterSessions.
		const repo = repoName ?? getRepoName();
		const legacyCompanionPrefix = `lazygit-${repo}-`;

		const result = runner(['list-sessions', '-F', '#{session_name}']);
		if (result.error || result.status !== 0) {
			return 0;
		}

		const orphans: string[] = [];
		for (const name of result.stdout.trim().split('\n')) {
			let key: string | null = null;
			if (name.startsWith(claudePrefix)) {
				key = fromSessionKey(name.slice(claudePrefix.length));
			} else if (name.startsWith(companionPrefix)) {
				key = fromSessionKey(name.slice(companionPrefix.length));
			} else if (name.startsWith(legacyCompanionPrefix)) {
				key = fromSessionKey(name.slice(legacyCompanionPrefix.length));
			} else {
				continue;
			}
			if (key === MAIN_WORKTREE_KEY) continue;
			if (registeredKeys.has(key)) continue;
			orphans.push(name);
		}

		let killed = 0;
		for (const name of orphans) {
			const k = runner(['kill-session', '-t', name]);
			if (!k.error && k.status === 0) {
				killed++;
				log.info(`Killed orphaned inner-socket session: ${name}`);
			}
		}
		return killed;
	} catch {
		return 0;
	}
}

/**
 * Delete the QA simulator cloned for a space
 * The simulator is named QA-{issueKey} (e.g., QA-STA-123)
 * Returns true if simulator was deleted or didn't exist
 */
export function deleteQaSimulator(issueKey: string): boolean {
	const simulatorName = `QA-${issueKey}`;

	// Skip if xcrun is not available (machines without Xcode)
	const which = spawnSync('which', ['xcrun'], {
		encoding: 'utf-8',
		timeout: 5000,
	});
	if (which.status !== 0) {
		log.debug('xcrun not available, skipping simulator cleanup');
		return true;
	}

	try {
		// Find the simulator UDID by name
		const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
			encoding: 'utf-8',
			timeout: 10000,
		});

		if (result.error || result.status !== 0) {
			const stderr = result.stderr?.trim() ?? '';
			if (isSimctlUnavailableError(stderr)) {
				log.debug('simctl not available, skipping simulator cleanup');
				return true;
			}

			log.error(`Failed to list simulators: ${stderr}`);
			return false;
		}

		// Parse JSON output to find our simulator
		const data = JSON.parse(result.stdout) as {
			devices: Record<string, Array<{name: string; udid: string}>>;
		};

		let simulatorUdid: string | null = null;

		// Search through all runtimes for our simulator
		for (const devices of Object.values(data.devices)) {
			const found = devices.find(d => d.name === simulatorName);
			if (found) {
				simulatorUdid = found.udid;
				break;
			}
		}

		if (!simulatorUdid) {
			log.debug(`Simulator ${simulatorName} not found, nothing to delete`);
			return true;
		}

		// Delete the simulator
		const deleteResult = spawnSync(
			'xcrun',
			['simctl', 'delete', simulatorUdid],
			{encoding: 'utf-8', timeout: 30000},
		);

		if (deleteResult.error || deleteResult.status !== 0) {
			log.error(
				`Failed to delete simulator ${simulatorName}: ${deleteResult.stderr}`,
			);
			return false;
		}

		log.info(`Deleted QA simulator: ${simulatorName} (${simulatorUdid})`);
		return true;
	} catch (err) {
		log.error(
			`Failed to delete simulator for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Kill both claude and companion sessions for a space, and delete the QA simulator
 * Returns true if all sessions were killed successfully
 */
export function killSpaceSessions(issueKey: string): boolean {
	const sessions = getSessionNames(issueKey);
	const claudeKilled = innerKillSession(sessions.claude);
	const companionKilled = innerKillSession(sessions.companion);

	// Delete the QA simulator (runs in background, doesn't block)
	deleteQaSimulator(issueKey);

	// If we just killed the sessions for the currently viewing space, clear the state
	if (currentlyViewingSpace === issueKey) {
		currentlyViewingSpace = null;
		claudeViewerHasClient = false;
		companionViewerHasClient = false;
	}

	return claudeKilled && companionKilled;
}

/**
 * Send keys to a pane (for attaching to sessions or sending commands)
 * Clears any partial input first to avoid leftover characters
 */
export function sendToPane(paneId: string, command: string): boolean {
	try {
		// Clear any partial input on the line first (Ctrl+U)
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-u'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		// Send the command text (literal to avoid key name interpretation)
		spawnSync('tmux', ['send-keys', '-t', paneId, '-l', command], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		// Send Enter separately so it's not batched with the text
		// (otherwise Claude Code treats the whole thing as a paste
		// and the Enter becomes a literal newline)
		spawnSync('tmux', ['send-keys', '-t', paneId, 'Enter'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch (err) {
		log.error(
			`Failed to send command to pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Send Ctrl+C to interrupt any running process in a pane
 */
function interruptPane(paneId: string): void {
	try {
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-c'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	} catch {
		// Ignore errors
	}
}

/**
 * Detach from any tmux session running in a pane
 * This sends the detach command (prefix + d) to the nested tmux
 */
function detachInPane(paneId: string): void {
	try {
		// Send Ctrl+B then d (tmux detach) - works for nested tmux
		spawnSync('tmux', ['send-keys', '-t', paneId, 'C-b', 'd'], {
			encoding: 'utf-8',
			timeout: 5000,
		});
	} catch {
		// Ignore errors
	}
}

// ============================================================================
// Tmux Dimension Helpers
// ============================================================================

/**
 * Get the window size (full terminal dimensions, not individual pane size)
 * This is needed for relayout calculations since individual panes may have
 * stale sizes after a resize.
 */
function getTmuxWindowSize(): {width: number; height: number} | null {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '#{window_width} #{window_height}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return null;
		}
		const parts = result.stdout.trim().split(' ');
		const width = parseInt(parts[0] ?? '', 10);
		const height = parseInt(parts[1] ?? '', 10);
		if (isNaN(width) || isNaN(height)) {
			return null;
		}
		return {width, height};
	} catch {
		return null;
	}
}

/**
 * Build the `tmux display-message` argv for reading a pane format variable.
 *
 * `display-message` resolves an untargeted format against the *active* pane,
 * not the calling process's pane. pappardelle lives in a sidebar the user
 * spends most of their time focused away from, so an untargeted query reports
 * whatever pane the cursor happens to be in — usually the much wider claude
 * pane. `$TMUX_PANE` is the pane id tmux exports into every process it spawns,
 * so targeting it is what pins the answer to our own pane.
 */
export function paneQueryArgs(format: string, paneId?: string): string[] {
	const args = ['display-message', '-p'];
	if (paneId) args.push('-t', paneId);
	args.push(format);
	return args;
}

function queryPaneDimension(format: string, fallback: number): number {
	try {
		const result = spawnSync(
			'tmux',
			paneQueryArgs(format, process.env['TMUX_PANE']),
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) {
			return fallback;
		}
		return parseInt(result.stdout.trim(), 10) || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Get the width of a specific pane, or null when tmux cannot report it.
 *
 * Distinct from `getTmuxPaneWidth`, which asks about the calling pane. The rail
 * override needs to measure the list pane by id, from whichever pane asks.
 */
function getPaneWidth(paneId: string): number | null {
	try {
		const result = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{pane_width}'],
			{encoding: 'utf-8', timeout: 5000},
		);
		if (result.error || result.status !== 0) return null;
		const width = parseInt(result.stdout.trim(), 10);
		return isNaN(width) ? null : width;
	} catch {
		return null;
	}
}

/**
 * Get current terminal/pane width from tmux
 */
export function getTmuxPaneWidth(): number {
	return queryPaneDimension('#{pane_width}', 120);
}

/**
 * Get current terminal/pane height from tmux
 */
export function getTmuxPaneHeight(): number {
	return queryPaneDimension('#{pane_height}', 40);
}

/**
 * Get the number of active spaces from the persisted registry.
 * Uses the space registry (JSON file) as the single source of truth,
 * rather than querying tmux sessions directly. This ensures correct
 * counts even when pappardelle starts after a tmux server kill/reboot.
 */
export function getActiveSpaceCount(): number {
	return getRegisteredSpaces().length;
}

// ============================================================================
// Internal Wrapper Functions (use persisted space registry for counts)
// ============================================================================

/**
 * Number of items the list pane renders in addition to each registered space:
 * the always-pinned main-worktree row that app.tsx prepends to the list. Layout
 * sizing must include this row or the bottom of the list gets clipped on
 * narrow screens.
 */
const PINNED_LIST_ROWS = 1;

/**
 * Calculate the ideal list pane height based on current space count.
 * Reads from the persisted space registry and adds the pinned main-worktree row.
 */
export function calculateIdealListHeight(): number {
	return calculateIdealListHeightForCount(
		getActiveSpaceCount() + PINNED_LIST_ROWS,
	);
}

/**
 * Calculate pane layout based on terminal dimensions.
 * Reads space count from the persisted registry and adds the pinned
 * main-worktree row to the visible item count.
 */
export function calculateLayout(
	totalWidth: number,
	totalHeight: number,
): LayoutConfig {
	return calculateLayoutForSize(
		totalWidth,
		totalHeight,
		getActiveSpaceCount() + PINNED_LIST_ROWS,
		railWidthOverride,
	);
}

/**
 * Remember the window size and the *measured* rail width, so the next relayout
 * can tell a window resize from a hand-drag.
 *
 * Called after every operation that moves the panes. The rail width is measured
 * rather than assumed because tmux rounds split sizes, and an assumed value
 * would make the first harmless resize event look like a drag.
 */
function recordRailSample(
	listPaneId: string,
	windowDims: WindowSize | null,
): void {
	lastWindowSize = windowDims;
	lastRailWidth = getPaneWidth(listPaneId);
}

/**
 * Resize the list pane based on current session count (for vertical layout)
 * This should be called when spaces are added or deleted to keep the list
 * pane height optimal.
 *
 * Note: When we resize the list pane, tmux automatically adjusts the claude
 * pane to fill the remaining space, so we only need to resize one pane.
 *
 * Returns true if resize was performed, false if not applicable (horizontal layout)
 */
export function resizeListPaneForSessionCount(listPaneId: string): boolean {
	try {
		// Only resize in vertical layout mode
		const totalWidth = getTmuxPaneWidth();
		if (totalWidth >= NARROW_SCREEN_THRESHOLD) {
			log.debug('Not resizing: horizontal layout mode');
			return false;
		}

		const newListHeight = calculateIdealListHeight();

		// Resize the list pane to the new height
		const result = spawnSync(
			'tmux',
			['resize-pane', '-t', listPaneId, '-y', String(newListHeight)],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to resize list pane: ${result.stderr}`);
			return false;
		}

		const spaceCount = getActiveSpaceCount();
		log.info(
			`Resized list pane for ${spaceCount} spaces: list=${newListHeight} rows`,
		);
		return true;
	} catch (err) {
		log.error(
			'Failed to resize list pane',
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Check if we're in vertical layout mode (narrow screen)
 */
export function isVerticalLayout(): boolean {
	const totalWidth = getTmuxPaneWidth();
	return totalWidth < NARROW_SCREEN_THRESHOLD;
}

/**
 * Set up the pane layout for pappardelle
 * Returns pane IDs for [list, claudeViewer, companionViewer]
 *
 * Layout depends on screen width:
 * - Narrow screens (< 100 chars): Vertical layout [list on top] [claude below], no companion
 * - Wide screens (>= 100 chars): Horizontal layout [list] [claude] [companion]
 */
export function setupPappardellLayout(): {
	listPaneId: string;
	claudeViewerPaneId: string;
	companionViewerPaneId: string;
} | null {
	try {
		// Get current pane from TMUX_PANE env var
		const listPaneId = process.env['TMUX_PANE'];
		if (!listPaneId) {
			log.error('TMUX_PANE environment variable not set');
			return null;
		}

		const cwd = process.cwd();

		// Get terminal dimensions and calculate layout
		const totalWidth = getTmuxPaneWidth();
		const totalHeight = getTmuxPaneHeight();
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Terminal size: ${totalWidth}x${totalHeight}, layout: ${layout.direction}`,
		);

		let claudeViewerPaneId: string;
		let companionViewerPaneId = ''; // Empty by default (not created for vertical layout)

		if (layout.direction === 'vertical') {
			// VERTICAL LAYOUT: list on top, claude below, no companion
			// Use -v for vertical split (top/bottom)
			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-v', // vertical split (top/bottom)
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(layout.claudeHeight), // claude pane gets this many rows
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Failed to create claude viewer pane: ${claudeResult.stderr}`,
				);
				return null;
			}

			claudeViewerPaneId = claudeResult.stdout.trim();

			log.info(
				`Vertical layout: list=${layout.listHeight} rows, claude=${layout.claudeHeight} rows`,
			);
		} else {
			// HORIZONTAL LAYOUT: list | claude | companion (existing logic)
			// Create the right portion (claude + companion combined)
			const rightPortionWidth =
				(layout.claudeWidth ?? 40) + (layout.companionWidth ?? 0) + 1; // +1 for border

			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-h', // horizontal split (left/right)
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(rightPortionWidth),
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Failed to create claude viewer pane: ${claudeResult.stderr}`,
				);
				return null;
			}

			claudeViewerPaneId = claudeResult.stdout.trim();

			// Create right pane (companion viewer) from the claude pane
			// Only create if we have space for companion
			if ((layout.companionWidth ?? 0) >= MIN_COMPANION_WIDTH) {
				const companionResult = spawnSync(
					'tmux',
					[
						'split-window',
						'-h',
						'-t',
						claudeViewerPaneId,
						'-c',
						cwd,
						'-l',
						String(layout.companionWidth),
						'-P',
						'-F',
						'#{pane_id}',
					],
					{encoding: 'utf-8', timeout: 10000},
				);

				if (companionResult.error || companionResult.status !== 0) {
					log.error(
						`Failed to create companion viewer pane: ${companionResult.stderr}`,
					);
					// Continue without companion pane
				} else {
					companionViewerPaneId = companionResult.stdout.trim();
				}
			} else {
				log.info(
					`Not enough space for companion pane (need ${MIN_COMPANION_WIDTH}, have ${layout.companionWidth})`,
				);
			}

			log.info(
				`Horizontal layout: list=${layout.listWidth}, claude=${layout.claudeWidth}, companion=${layout.companionWidth}`,
			);
		}

		// Set pane titles
		execSync(`tmux select-pane -t "${listPaneId}" -T "pappardelle"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync(`tmux select-pane -t "${claudeViewerPaneId}" -T "claude-viewer"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		if (companionViewerPaneId) {
			execSync(
				`tmux select-pane -t "${companionViewerPaneId}" -T "companion-viewer"`,
				{
					encoding: 'utf-8',
					timeout: 5000,
				},
			);
		}

		// Set window-level options for better focus highlighting
		// These only affect the current window, not other tmux sessions
		execSync('tmux set-option -w pane-border-style "fg=colour238"', {
			encoding: 'utf-8',
			timeout: 5000,
		});
		execSync('tmux set-option -w pane-active-border-style "fg=cyan,bold"', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		enableSynchronizedOutput();

		// Return focus to list pane
		execSync(`tmux select-pane -t "${listPaneId}"`, {
			encoding: 'utf-8',
			timeout: 5000,
		});

		log.info(
			`Set up pappardelle layout: list=${listPaneId}, claude=${claudeViewerPaneId}, companion=${
				companionViewerPaneId || '(none)'
			}`,
		);

		recordRailSample(listPaneId, getTmuxWindowSize());

		return {listPaneId, claudeViewerPaneId, companionViewerPaneId};
	} catch (err) {
		log.error(
			'Failed to set up pappardelle layout',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

/**
 * Attach viewer panes to a space's sessions
 *
 * Uses tmux switch-client for instant, invisible session switching when a nested
 * client already exists in the viewer pane. Falls back to send-keys attach for
 * the initial attachment.
 *
 * This avoids the visible attach command being typed into the pane, which was
 * jarring when rapidly navigating through spaces.
 */
export function attachToSpace(
	claudeViewerPaneId: string,
	companionViewerPaneId: string,
	issueKey: string,
	listPaneId?: string,
	mainWorktreePath?: string,
	issueTitle?: string,
): boolean {
	// If already viewing this space, nothing to do
	if (currentlyViewingSpace === issueKey) {
		return true;
	}

	const sessions = getSessionNames(issueKey);

	// Load config once for all session creation. The companion command and the
	// Claude launch flags are resolved profile-aware (via the issue title) so a
	// per-project profile can override the default git UI, model, and effort.
	// This matters only when the sessions don't already exist (idow creates
	// them with the same resolution at workspace-create time).
	let skipPermissions = false;
	let companionCommand = DEFAULT_COMPANION_COMMAND;
	let launch: ClaudeLaunchOptions = {};
	try {
		const config = loadConfig();
		skipPermissions = getDangerouslySkipPermissions(config);
		companionCommand = getCompanionCommand(config, issueTitle);
		launch = {
			model: getClaudeModel(config, issueTitle),
			effort: getClaudeEffort(config, issueTitle),
		};
	} catch {
		// Config load failed — use safe defaults
	}

	// Ensure sessions exist (create if needed)
	if (mainWorktreePath) {
		ensureClaudeSession(issueKey, mainWorktreePath, skipPermissions, launch);
		ensureCompanionSession(issueKey, mainWorktreePath, companionCommand);
	} else {
		ensureClaudeSession(issueKey, undefined, skipPermissions, launch);
		ensureCompanionSession(issueKey, undefined, companionCommand);
	}

	const hasClaudeSession = innerSessionExists(sessions.claude);
	const hasCompanionSession = innerSessionExists(sessions.companion);

	// Cache pane TTYs if we haven't yet (needed for switch-client)
	if (!claudeViewerTty) {
		claudeViewerTty = getPaneTty(claudeViewerPaneId);
	}
	if (!companionViewerTty && companionViewerPaneId) {
		companionViewerTty = getPaneTty(companionViewerPaneId);
	}

	try {
		// Handle Claude viewer pane
		if (hasClaudeSession) {
			// Check if we already have a nested client running in this pane
			const hasExistingClient =
				claudeViewerTty && clientExistsOnTty(claudeViewerTty);

			if (hasExistingClient && claudeViewerHasClient) {
				// Fast path: switch the existing client to the new session (instant, invisible)
				switchClientToSession(claudeViewerTty!, sessions.claude);
				log.debug(
					`Switched claude viewer to ${sessions.claude} via switch-client`,
				);
			} else {
				// Slow path: create a new nested client via send-keys.
				// The per-issue session lives on the inner socket, so attach via
				// `tmux -L pappardelle_inner attach`. A distinct socket means a
				// distinct tmux server, so tmux's nesting check can't fire and we
				// don't need to clobber $TMUX — which is the whole point of STA-860
				// (lets $TMUX propagate to Claude Code's Agent Teams feature).
				sendToPane(
					claudeViewerPaneId,
					`tmux -L ${INNER_SOCKET} attach -t "${sessions.claude}"`,
				);
				claudeViewerHasClient = true;
				log.info(`Attached claude viewer to ${sessions.claude} via send-keys`);
			}
		} else {
			// No session - show message (need to detach first if we have a client)
			if (claudeViewerHasClient && claudeViewerTty) {
				detachInPane(claudeViewerPaneId);
				claudeViewerHasClient = false;
			}
			sendToPane(
				claudeViewerPaneId,
				`clear && echo "No claude session for ${issueKey}"`,
			);
		}

		// Handle companion viewer pane (only if we have one - may not exist on narrow screens)
		if (companionViewerPaneId) {
			if (hasCompanionSession) {
				// Check if we already have a nested client running in this pane
				const hasExistingClient =
					companionViewerTty && clientExistsOnTty(companionViewerTty);

				if (hasExistingClient && companionViewerHasClient) {
					// Fast path: switch the existing client to the new session
					switchClientToSession(companionViewerTty!, sessions.companion);
					log.debug(
						`Switched companion viewer to ${sessions.companion} via switch-client`,
					);
				} else {
					// Slow path: create a new nested client on the inner socket.
					sendToPane(
						companionViewerPaneId,
						`tmux -L ${INNER_SOCKET} attach -t "${sessions.companion}"`,
					);
					companionViewerHasClient = true;
					log.info(
						`Attached companion viewer to ${sessions.companion} via send-keys`,
					);
				}
			} else {
				// No session - show message
				if (companionViewerHasClient && companionViewerTty) {
					detachInPane(companionViewerPaneId);
					companionViewerHasClient = false;
				}
				sendToPane(
					companionViewerPaneId,
					`clear && echo "No companion session for ${issueKey}"`,
				);
			}
		} else {
			companionViewerHasClient = false;
		}

		// Return focus to the list pane
		if (listPaneId) {
			spawnSync('tmux', ['select-pane', '-t', listPaneId], {
				encoding: 'utf-8',
				timeout: 5000,
			});
		}

		currentlyViewingSpace = issueKey;
		return true;
	} catch (err) {
		log.error(
			`Failed to attach to space ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Display a message in a pane (for empty state)
 */
export function displayMessageInPane(paneId: string, message: string): boolean {
	try {
		interruptPane(paneId);
		if (message) {
			sendToPane(paneId, `echo "${message}"`);
		} else {
			sendToPane(paneId, 'clear');
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the currently viewing space (for state tracking)
 */
export function getCurrentlyViewingSpace(): string | null {
	return currentlyViewingSpace;
}

/**
 * Clear the currently viewing state (e.g., on shutdown)
 */
export function clearCurrentlyViewingSpace(): void {
	currentlyViewingSpace = null;
}

/**
 * Get the current layout direction based on window dimensions.
 * Used to detect when the layout mode needs to switch.
 */
export function getCurrentLayoutDirection(): 'horizontal' | 'vertical' | null {
	const windowDims = getTmuxWindowSize();
	if (!windowDims) return null;
	return windowDims.width >= NARROW_SCREEN_THRESHOLD
		? 'horizontal'
		: 'vertical';
}

/**
 * Kill a tmux pane by ID.
 * Returns true if pane was killed or didn't exist.
 */
function killPane(paneId: string): boolean {
	if (!paneId) return true;
	try {
		const result = spawnSync('tmux', ['kill-pane', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		if (result.error || result.status !== 0) {
			log.warn(`Failed to kill pane ${paneId}: ${result.stderr}`);
			return false;
		}
		log.debug(`Killed pane ${paneId}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebuild the tmux pane layout when the layout direction changes.
 * Kills old viewer panes and creates new ones with the correct orientation.
 *
 * The list pane (where the Ink app runs) is preserved — only viewer panes
 * are destroyed and recreated.
 *
 * Returns the new PaneLayout, or null on failure.
 */
export function rebuildLayout(
	listPaneId: string,
	oldClaudeViewerPaneId: string,
	oldCompanionViewerPaneId: string,
): {
	listPaneId: string;
	claudeViewerPaneId: string;
	companionViewerPaneId: string;
} | null {
	try {
		// Detach any nested clients before killing panes
		if (oldClaudeViewerPaneId) {
			if (claudeViewerHasClient) {
				detachInPane(oldClaudeViewerPaneId);
			}
			killPane(oldClaudeViewerPaneId);
		}
		if (oldCompanionViewerPaneId) {
			if (companionViewerHasClient) {
				detachInPane(oldCompanionViewerPaneId);
			}
			killPane(oldCompanionViewerPaneId);
		}

		// Reset cached state since panes are destroyed
		claudeViewerHasClient = false;
		companionViewerHasClient = false;
		claudeViewerTty = null;
		companionViewerTty = null;
		currentlyViewingSpace = null;

		const cwd = process.cwd();

		// Get terminal dimensions and calculate new layout
		const windowDims = getTmuxWindowSize();
		if (!windowDims) {
			log.error('Failed to get window dimensions for rebuild');
			return null;
		}

		const {width: totalWidth, height: totalHeight} = windowDims;
		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Rebuilding layout: ${totalWidth}x${totalHeight}, mode=${layout.direction}`,
		);

		let claudeViewerPaneId: string;
		let companionViewerPaneId = '';

		if (layout.direction === 'vertical') {
			// VERTICAL: list on top, claude below
			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-v',
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(layout.claudeHeight),
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Rebuild: failed to create claude pane: ${claudeResult.stderr}`,
				);
				return null;
			}
			claudeViewerPaneId = claudeResult.stdout.trim();

			log.info(
				`Rebuilt vertical: list=${layout.listHeight}, claude=${layout.claudeHeight}`,
			);
		} else {
			// HORIZONTAL: list | claude | companion
			const rightPortionWidth =
				(layout.claudeWidth ?? 40) + (layout.companionWidth ?? 0) + 1;

			const claudeResult = spawnSync(
				'tmux',
				[
					'split-window',
					'-h',
					'-t',
					listPaneId,
					'-c',
					cwd,
					'-l',
					String(rightPortionWidth),
					'-P',
					'-F',
					'#{pane_id}',
				],
				{encoding: 'utf-8', timeout: 10000},
			);

			if (claudeResult.error || claudeResult.status !== 0) {
				log.error(
					`Rebuild: failed to create claude pane: ${claudeResult.stderr}`,
				);
				return null;
			}
			claudeViewerPaneId = claudeResult.stdout.trim();

			if ((layout.companionWidth ?? 0) >= MIN_COMPANION_WIDTH) {
				const companionResult = spawnSync(
					'tmux',
					[
						'split-window',
						'-h',
						'-t',
						claudeViewerPaneId,
						'-c',
						cwd,
						'-l',
						String(layout.companionWidth),
						'-P',
						'-F',
						'#{pane_id}',
					],
					{encoding: 'utf-8', timeout: 10000},
				);

				if (!companionResult.error && companionResult.status === 0) {
					companionViewerPaneId = companionResult.stdout.trim();
				}
			}

			log.info(
				`Rebuilt horizontal: list=${layout.listWidth}, claude=${layout.claudeWidth}, companion=${layout.companionWidth}`,
			);
		}

		// Set pane titles
		try {
			execSync(
				`tmux select-pane -t "${claudeViewerPaneId}" -T "claude-viewer"`,
				{encoding: 'utf-8', timeout: 5000},
			);
			if (companionViewerPaneId) {
				execSync(
					`tmux select-pane -t "${companionViewerPaneId}" -T "companion-viewer"`,
					{encoding: 'utf-8', timeout: 5000},
				);
			}
		} catch {
			// Non-fatal
		}

		// Return focus to list pane
		spawnSync('tmux', ['select-pane', '-t', listPaneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		log.info(
			`Layout rebuilt: claude=${claudeViewerPaneId}, companion=${companionViewerPaneId || '(none)'}`,
		);

		recordRailSample(listPaneId, getTmuxWindowSize());

		return {listPaneId, claudeViewerPaneId, companionViewerPaneId};
	} catch (err) {
		log.error(
			'Failed to rebuild layout',
			err instanceof Error ? err : undefined,
		);
		return null;
	}
}

/**
 * Relayout tmux panes based on current terminal dimensions.
 * Call this when the terminal is resized to keep panes properly proportioned.
 *
 * For horizontal layout: resizes list and companion widths (claude gets remainder)
 * For vertical layout: resizes list height (claude gets remainder)
 *
 * This only re-proportions within the current layout mode. For switching between
 * horizontal/vertical, use rebuildLayout() instead.
 */
export function relayoutPanes(
	listPaneId: string,
	companionViewerPaneId: string,
): boolean {
	try {
		// Get current terminal dimensions from the window (not individual panes)
		const windowDims = getTmuxWindowSize();
		if (!windowDims) {
			log.error('Failed to get tmux window dimensions for relayout');
			return false;
		}

		const {width: totalWidth, height: totalHeight} = windowDims;

		// Separate a window resize from a hand-drag of the rail/claude border
		// *before* computing the layout, so a drag feeds its own width back in
		// instead of being recomputed away. See rail-width.ts and STA-2040.
		const measuredRailWidth = getPaneWidth(listPaneId);
		const previousOverride = railWidthOverride;
		railWidthOverride = nextRailWidthOverride({
			previousWindow: lastWindowSize,
			currentWindow: windowDims,
			previousRailWidth: lastRailWidth,
			currentRailWidth: measuredRailWidth,
			currentOverride: railWidthOverride,
		});
		if (railWidthOverride !== previousOverride) {
			log.info(
				`Rail resized by hand: width=${railWidthOverride} (was ${previousOverride ?? 'default'})`,
			);
		}

		const layout = calculateLayout(totalWidth, totalHeight);

		log.info(
			`Relayout: ${totalWidth}x${totalHeight}, mode=${layout.direction}` +
				(railWidthOverride === null ? '' : `, rail=${railWidthOverride}`),
		);

		if (layout.direction === 'vertical') {
			// Vertical: resize list pane height, claude gets remainder
			if (layout.listHeight !== undefined) {
				const result = spawnSync(
					'tmux',
					['resize-pane', '-t', listPaneId, '-y', String(layout.listHeight)],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane height: ${result.stderr}`);
					return false;
				}
			}
		} else {
			// Horizontal: resize list width and companion width, claude gets remainder
			if (layout.listWidth !== undefined) {
				const result = spawnSync(
					'tmux',
					['resize-pane', '-t', listPaneId, '-x', String(layout.listWidth)],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize list pane width: ${result.stderr}`);
					return false;
				}
			}

			if (companionViewerPaneId && layout.companionWidth !== undefined) {
				const result = spawnSync(
					'tmux',
					[
						'resize-pane',
						'-t',
						companionViewerPaneId,
						'-x',
						String(layout.companionWidth),
					],
					{encoding: 'utf-8', timeout: 5000},
				);
				if (result.error || result.status !== 0) {
					log.error(`Failed to resize companion pane width: ${result.stderr}`);
					// Non-fatal, continue
				}
			}
		}

		recordRailSample(listPaneId, windowDims);

		log.info('Relayout completed successfully');
		return true;
	} catch (err) {
		log.error(
			'Failed to relayout panes',
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Zoom a pane to take up the full terminal window
 * Uses tmux's built-in zoom feature which maximizes the pane
 */
export function zoomPane(paneId: string): boolean {
	try {
		// Check if already zoomed
		const checkResult = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (checkResult.stdout.trim() === '1') {
			log.debug(`Pane ${paneId} is already zoomed`);
			return true;
		}

		const result = spawnSync('tmux', ['resize-pane', '-Z', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		if (result.error || result.status !== 0) {
			log.error(`Failed to zoom pane ${paneId}: ${result.stderr}`);
			return false;
		}

		log.info(`Zoomed pane ${paneId}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to zoom pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Unzoom a pane to restore the normal layout
 */
export function unzoomPane(paneId: string): boolean {
	try {
		// Check if actually zoomed
		const checkResult = spawnSync(
			'tmux',
			['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'],
			{encoding: 'utf-8', timeout: 5000},
		);

		if (checkResult.stdout.trim() !== '1') {
			log.debug(`Pane ${paneId} is not zoomed, nothing to unzoom`);
			return true;
		}

		const result = spawnSync('tmux', ['resize-pane', '-Z', '-t', paneId], {
			encoding: 'utf-8',
			timeout: 5000,
		});

		if (result.error || result.status !== 0) {
			log.error(`Failed to unzoom pane ${paneId}: ${result.stderr}`);
			return false;
		}

		log.info(`Unzoomed pane ${paneId}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to unzoom pane ${paneId}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Get the worktree path for an issue key
 */
export function getWorktreePath(issueKey: string): string | null {
	try {
		const homeDir = process.env['HOME'] ?? '';
		const repoName = getRepoName();
		const worktreePath = `${homeDir}/.worktrees/${repoName}/${issueKey}`;

		return existsSync(worktreePath) && statSync(worktreePath).isDirectory()
			? worktreePath
			: null;
	} catch {
		return null;
	}
}

/**
 * Get the main worktree info (path and branch name).
 * The main worktree is the original git checkout (not a `git worktree add` worktree).
 * Returns null if detection fails.
 */
export async function getMainWorktreeInfo(): Promise<{
	path: string;
	branch: string;
} | null> {
	try {
		// `git worktree list --porcelain` outputs blocks like:
		//   worktree /path/to/repo
		//   HEAD abc123
		//   branch refs/heads/master
		//
		// The first block is always the main worktree.
		const {stdout} = await execAsync('git worktree list --porcelain', {
			encoding: 'utf-8',
			timeout: 5000,
		});

		const lines = stdout.split('\n');
		let path: string | null = null;
		let branch: string | null = null;

		for (const line of lines) {
			if (line.startsWith('worktree ') && !path) {
				path = line.slice('worktree '.length);
			} else if (line.startsWith('branch ') && !branch) {
				// e.g. "branch refs/heads/master" → "master"
				branch = line.slice('branch '.length).replace('refs/heads/', '');
			} else if (line === '' && path) {
				// End of first worktree block
				break;
			}
		}

		if (path && branch) {
			return {path, branch};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Pre-trust a directory for Claude Code by writing hasTrustDialogAccepted
 * to ~/.claude.json. Without this, every new worktree directory triggers
 * a "do you trust this folder?" prompt that blocks the interactive session.
 *
 * This trust dialog was introduced in Claude Code v2.1.53 for directories
 * with risky project settings (e.g. .claude/commands/ with Bash tool access).
 */
export function pretrustDirectoryForClaude(
	worktreePath: string,
	configPath?: string,
): void {
	const resolvedConfigPath = configPath ?? join(homedir(), '.claude.json');
	try {
		let config: Record<string, unknown> = {};
		try {
			config = JSON.parse(readFileSync(resolvedConfigPath, 'utf-8'));
		} catch {
			// File doesn't exist or is invalid JSON - start fresh
		}

		const projects = (config['projects'] ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		if (!projects[worktreePath]) {
			projects[worktreePath] = {};
		}
		if (!projects[worktreePath]!['hasTrustDialogAccepted']) {
			projects[worktreePath]!['hasTrustDialogAccepted'] = true;
			config['projects'] = projects;
			writeFileSync(
				resolvedConfigPath,
				JSON.stringify(config, null, 2),
				'utf-8',
			);
			log.info(`Pre-trusted directory for Claude: ${worktreePath}`);
		}
	} catch (err) {
		log.warn(
			`Failed to pre-trust directory for Claude: ${worktreePath}`,
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * Create a claude session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * Creates a shell-based session (not running claude directly) so the session
 * persists even if claude exits.
 */
export function ensureClaudeSession(
	issueKey: string,
	explicitWorktreePath?: string,
	skipPermissions = false,
	launch: ClaudeLaunchOptions = {},
): boolean {
	const sessionName = getSessionNames(issueKey).claude;

	// Already exists on the inner socket?
	if (innerSessionExists(sessionName)) {
		return true;
	}

	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(`Cannot create claude session for ${issueKey}: no worktree found`);
		return false;
	}

	// Pre-trust the worktree directory so Claude doesn't ask "do you trust this folder?"
	pretrustDirectoryForClaude(worktreePath);

	try {
		const result = spawnSync(
			'tmux',
			innerTmuxArgs([
				'new-session',
				'-d',
				'-s',
				sessionName,
				'-c',
				worktreePath,
			]),
			{encoding: 'utf-8', timeout: 10000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to create claude session: ${result.stderr}`);
			return false;
		}

		// Send claude command to the session. Try --continue first to resume an
		// existing conversation, falling back to bare claude if none exists.
		const fullCmd = buildClaudeResumeCommand(issueKey, skipPermissions, launch);

		spawnSync(
			'tmux',
			innerTmuxArgs(['send-keys', '-t', sessionName, fullCmd, 'Enter']),
			{
				encoding: 'utf-8',
				timeout: 5000,
			},
		);

		log.info(`Created claude session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to create claude session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}

/**
 * Create a companion session for an issue if it doesn't exist
 * Returns true if session exists or was created successfully
 *
 * Creates a shell-based session (not running the companion command directly) so
 * the session persists even if that command exits. This matches how claude
 * sessions work.
 *
 * `companionCommand` is the shell command run in the pane — defaults to gitui
 * (see DEFAULT_COMPANION_COMMAND) and is overridable via the `companion_command`
 * config field. An empty/whitespace-only command leaves a plain shell.
 */
export function ensureCompanionSession(
	issueKey: string,
	explicitWorktreePath?: string,
	companionCommand: string = DEFAULT_COMPANION_COMMAND,
): boolean {
	const sessionName = getSessionNames(issueKey).companion;

	// Already exists on the inner socket?
	if (innerSessionExists(sessionName)) {
		return true;
	}

	const worktreePath = explicitWorktreePath ?? getWorktreePath(issueKey);
	if (!worktreePath) {
		log.warn(
			`Cannot create companion session for ${issueKey}: no worktree found`,
		);
		return false;
	}

	try {
		// Detached shell-based session (not running the companion command directly)
		// so it persists even if that command exits.
		const result = spawnSync(
			'tmux',
			innerTmuxArgs([
				'new-session',
				'-d',
				'-s',
				sessionName,
				'-c',
				worktreePath,
			]),
			{encoding: 'utf-8', timeout: 10000},
		);

		if (result.error || result.status !== 0) {
			log.error(`Failed to create companion session: ${result.stderr}`);
			return false;
		}

		// An empty command means "leave a plain shell" — create the session but
		// don't launch anything into it.
		if (companionCommand.trim() !== '') {
			// The default command carries GIT_OPTIONAL_LOCKS=0, which keeps the git
			// UI from acquiring locks for read-only ops like `git status`, avoiding
			// contention with Claude's concurrent git calls. Custom commands run
			// verbatim.
			spawnSync(
				'tmux',
				innerTmuxArgs([
					'send-keys',
					'-t',
					sessionName,
					companionCommand,
					'Enter',
				]),
				{
					encoding: 'utf-8',
					timeout: 5000,
				},
			);
		}

		log.info(`Created companion session: ${sessionName}`);
		return true;
	} catch (err) {
		log.error(
			`Failed to create companion session for ${issueKey}`,
			err instanceof Error ? err : undefined,
		);
		return false;
	}
}
