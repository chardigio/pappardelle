// Tests for the inner-socket routing that isolates per-issue claude/lazygit
// sessions onto `tmux -L pappardelle_inner`. See STA-860.
//
// The point of these tests is not to exercise real tmux (that belongs in the
// integration-tests/ directory) — it's to lock down the argv shape the
// TypeScript layer builds. Specifically: every inner-session call site must
// route through a single helper so a future caller that forgets the `-L` flag
// fails CI rather than silently regressing nested-tmux behavior.
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {
	INNER_SOCKET,
	cleanupOrphanedInnerSessions,
	cleanupOrphanedOuterSessions,
	innerTmuxArgs,
	type OuterTmuxRunner,
} from './tmux.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMUX_SOURCE = readFileSync(join(__dirname, 'tmux.ts'), 'utf-8');

test('INNER_SOCKET is pappardelle_inner', t => {
	t.is(INNER_SOCKET, 'pappardelle_inner');
});

test('innerTmuxArgs prefixes -L INNER_SOCKET', t => {
	t.deepEqual(innerTmuxArgs(['has-session', '-t', 'claude-repo-STA-1']), [
		'-L',
		'pappardelle_inner',
		'has-session',
		'-t',
		'claude-repo-STA-1',
	]);
});

test('innerTmuxArgs with empty args still includes -L prefix', t => {
	t.deepEqual(innerTmuxArgs([]), ['-L', 'pappardelle_inner']);
});

test('innerTmuxArgs does not mutate the input array', t => {
	const input = ['list-sessions'];
	innerTmuxArgs(input);
	t.deepEqual(input, ['list-sessions']);
});

// ============================================================================
// Call-site regression guards
//
// These scan the tmux.ts source to assert that inner-session operations are
// *always* routed through innerTmuxArgs / innerSessionExists / innerKillSession
// (and not via a bare `tmux ...` invocation that targets the default socket).
// If a future patch adds a call site that forgets the socket, these tests fail.
// ============================================================================

test('new-session for per-issue sessions routes through innerTmuxArgs', t => {
	// The two call sites that create claude/lazygit sessions (ensureClaudeSession
	// and ensureLazygitSession) both call innerTmuxArgs with 'new-session'.
	const matches =
		TMUX_SOURCE.match(/innerTmuxArgs\(\[\s*['"]new-session['"]/g) ?? [];
	t.true(
		matches.length >= 2,
		`expected >=2 innerTmuxArgs(['new-session', ...]) call sites, got ${matches.length}`,
	);
});

test('no bare `tmux new-session -d` survives for per-issue sessions', t => {
	// The only new-session call that is allowed to skip the inner socket is the
	// outer `pappardelle-{repo}` root session in cli.tsx. Inside tmux.ts, every
	// new-session call must go through innerTmuxArgs.
	const bareDetachedNewSession = TMUX_SOURCE.match(
		/spawnSync\(\s*['"]tmux['"]\s*,\s*\[\s*['"]new-session['"]\s*,\s*['"]-d['"]/g,
	);
	t.is(
		bareDetachedNewSession,
		null,
		'tmux.ts must not call `tmux new-session -d` directly; route via innerTmuxArgs',
	);
});

test('switch-client and list-clients route through innerTmuxArgs', t => {
	// Nested clients live on the inner socket, so both list-clients and
	// switch-client need the -L prefix.
	t.regex(
		TMUX_SOURCE,
		/innerTmuxArgs\(\[\s*['"]list-clients['"]/,
		'list-clients must be routed through innerTmuxArgs',
	);
	t.regex(
		TMUX_SOURCE,
		/innerTmuxArgs\(\[\s*['"]switch-client['"]/,
		'switch-client must be routed through innerTmuxArgs',
	);
});

test('attach command drops TMUX= and uses -L INNER_SOCKET', t => {
	// The viewer-pane attach is the critical fix: it must drop `TMUX=` (which
	// was the old nesting workaround) and use `tmux -L pappardelle_inner attach`
	// so the nested client's $TMUX points at the inner socket. The source uses
	// `${INNER_SOCKET}` interpolation rather than a string literal, so look for
	// either form.
	t.notRegex(
		TMUX_SOURCE,
		/TMUX=\s*tmux attach -t/,
		'attach command must not prefix TMUX=',
	);
	t.regex(
		TMUX_SOURCE,
		/tmux -L \$\{INNER_SOCKET\} attach -t/,
		'attach command must use the inner-socket form: tmux -L INNER_SOCKET attach -t',
	);
});

test('has-session via spawnSync routes through innerTmuxArgs', t => {
	// `has-session` may be used either via execSync (string form, for the outer
	// pappardelle-{repo} session in `sessionExists`) or via spawnSync+argv
	// (inner sessions). Every spawnSync form must route through innerTmuxArgs
	// — a bare `spawnSync('tmux', ['has-session', ...])` would silently target
	// the default socket and miss per-issue sessions.
	const bareHasSession = TMUX_SOURCE.match(
		/spawnSync\(\s*['"]tmux['"]\s*,\s*\[\s*['"]has-session['"]/g,
	);
	t.is(
		bareHasSession,
		null,
		'has-session spawnSync calls must go through innerTmuxArgs; use execSync only for the outer `pappardelle-{repo}` session',
	);
	t.regex(
		TMUX_SOURCE,
		/innerTmuxArgs\(\[\s*['"]has-session['"]/,
		'innerSessionExists must route has-session through innerTmuxArgs',
	);
});

test('kill-session for per-issue sessions routes through innerTmuxArgs', t => {
	// `innerKillSession` must route kill-session through innerTmuxArgs.
	// `cleanupOrphanedOuterSessions` intentionally bypasses this — it targets
	// the default socket to drop pre-STA-860 leftovers — but it's the only
	// permitted exception.
	t.regex(
		TMUX_SOURCE,
		/innerTmuxArgs\(\[\s*['"]kill-session['"]/,
		'innerKillSession must route kill-session through innerTmuxArgs',
	);

	// Count bare `'tmux', [ 'kill-session'` via spawnSync. Only
	// `cleanupOrphanedOuterSessions` should contain that shape, and only
	// indirectly via its injected runner (which emits `['kill-session', ...]`
	// argv). Today that kill-session call is in the runner argv, so it does
	// NOT appear as a literal spawnSync('tmux', ['kill-session', ...]) — if
	// somebody reintroduces that pattern directly in spawnSync, this guard
	// trips.
	const bareKillSession = TMUX_SOURCE.match(
		/spawnSync\(\s*['"]tmux['"]\s*,\s*\[\s*['"]kill-session['"]/g,
	);
	t.is(
		bareKillSession,
		null,
		'kill-session spawnSync calls must go through innerTmuxArgs or the injectable OuterTmuxRunner',
	);
});

// ============================================================================
// cleanupOrphanedOuterSessions
//
// Tested via the injectable OuterTmuxRunner (exposed for tests only) so we
// don't have to spawn real tmux processes. Each case builds a fake runner
// that returns canned list-sessions output and records which kill-session
// argv it was called with.
// ============================================================================

function makeFakeRunner(options: {
	listSessionsStdout?: string;
	listSessionsStatus?: number;
	listSessionsError?: Error;
	killStatus?: (name: string) => number;
}): {runner: OuterTmuxRunner; calls: string[][]} {
	const calls: string[][] = [];
	const runner: OuterTmuxRunner = args => {
		calls.push([...args]);
		if (args[0] === 'list-sessions') {
			return {
				error: options.listSessionsError,
				status: options.listSessionsStatus ?? 0,
				stdout: options.listSessionsStdout ?? '',
			};
		}
		if (args[0] === 'kill-session') {
			const name = args[2] ?? '';
			return {
				status: options.killStatus ? options.killStatus(name) : 0,
				stdout: '',
			};
		}
		return {status: 0, stdout: ''};
	};
	return {runner, calls};
}

test('cleanupOrphanedOuterSessions returns 0 when no sessions match', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: 'pappardelle-repo\nsome-other-session\n',
	});
	t.is(cleanupOrphanedOuterSessions('repo', runner), 0);
	// Should list but never kill.
	t.is(calls.length, 1);
	t.deepEqual(calls[0], ['list-sessions', '-F', '#{session_name}']);
});

test('cleanupOrphanedOuterSessions returns 0 when list-sessions errors', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStatus: 1,
		listSessionsStdout: '',
	});
	t.is(cleanupOrphanedOuterSessions('repo', runner), 0);
	t.is(calls.length, 1); // no kill attempts
});

test('cleanupOrphanedOuterSessions returns 0 when list-sessions throws', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsError: new Error('tmux not found'),
	});
	t.is(cleanupOrphanedOuterSessions('repo', runner), 0);
	t.is(calls.length, 1);
});

test('cleanupOrphanedOuterSessions only kills claude-{repo}-* / lazygit-{repo}-*', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'pappardelle-repo', // outer root — keep
			'claude-repo-STA-1', // kill
			'lazygit-repo-STA-1', // kill
			'claude-otherrepo-STA-2', // different repo — keep
			'claude-repo-foo', // kill (matches prefix even without issue-key shape)
			'unrelated-session', // keep
		].join('\n'),
	});
	t.is(cleanupOrphanedOuterSessions('repo', runner), 3);

	const killed = calls
		.filter(c => c[0] === 'kill-session')
		.map(c => c[2] ?? '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	t.deepEqual(killed, [
		'claude-repo-STA-1',
		'claude-repo-foo',
		'lazygit-repo-STA-1',
	]);
});

test('cleanupOrphanedOuterSessions counts only successful kills', t => {
	const {runner} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'claude-repo-STA-2',
			'lazygit-repo-STA-1',
		].join('\n'),
		killStatus: name => (name === 'claude-repo-STA-2' ? 1 : 0),
	});
	// 3 matched orphans, 1 kill fails → return 2.
	t.is(cleanupOrphanedOuterSessions('repo', runner), 2);
});

// ============================================================================
// cleanupOrphanedInnerSessions
//
// STA-1420 Layer 2: symmetric to cleanupOrphanedOuterSessions but on the
// inner socket. Reaps `claude-{repo}-*` / `lazygit-{repo}-*` sessions whose
// key is NOT in the registry and isn't the main worktree, which is what
// hard-quit (SIGKILL, terminal close, Ctrl-C mid-deinit) leaves behind now
// that STA-1416 removed seedFromTmux. Without this, orphans accumulate
// silently on the inner socket forever.
//
// `'main'` is the hardcoded key for the main worktree row (see app.tsx) — its
// sessions are legitimate and must never be reaped.
// ============================================================================

test('cleanupOrphanedInnerSessions returns 0 when no sessions match', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: 'pappardelle-repo\nsome-other-session\n',
	});
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 0);
	t.is(calls.length, 1);
	t.deepEqual(calls[0], ['list-sessions', '-F', '#{session_name}']);
});

test('cleanupOrphanedInnerSessions returns 0 when list-sessions errors', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStatus: 1,
		listSessionsStdout: '',
	});
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 0);
	t.is(calls.length, 1);
});

test('cleanupOrphanedInnerSessions returns 0 when list-sessions throws', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsError: new Error('tmux not found'),
	});
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 0);
	t.is(calls.length, 1);
});

test('cleanupOrphanedInnerSessions kills orphans (not in registry, not main)', t => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1', // registered → keep
			'lazygit-repo-STA-1', // registered → keep
			'claude-repo-STA-999', // orphan → kill
			'lazygit-repo-STA-999', // orphan → kill
			'claude-repo-main', // main worktree → keep
			'lazygit-repo-main', // main worktree → keep
			'claude-otherrepo-STA-2', // different repo → keep
			'pappardelle-repo', // outer root → keep
		].join('\n'),
	});
	t.is(cleanupOrphanedInnerSessions(new Set(['STA-1']), 'repo', runner), 2);

	const killed = calls
		.filter(c => c[0] === 'kill-session')
		.map(c => c[2] ?? '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	t.deepEqual(killed, ['claude-repo-STA-999', 'lazygit-repo-STA-999']);
});

test('cleanupOrphanedInnerSessions never touches main-worktree sessions', t => {
	// Empty registry — only main sessions exist. None should be killed.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: ['claude-repo-main', 'lazygit-repo-main'].join('\n'),
	});
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 0);
	const killAttempts = calls.filter(c => c[0] === 'kill-session');
	t.is(killAttempts.length, 0);
});

test('cleanupOrphanedInnerSessions counts only successful kills', t => {
	const {runner} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'claude-repo-STA-2',
			'lazygit-repo-STA-1',
		].join('\n'),
		killStatus: name => (name === 'claude-repo-STA-2' ? 1 : 0),
	});
	// 3 orphans (empty registry), 1 kill fails → return 2.
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 2);
});

test('cleanupOrphanedInnerSessions handles a partial pair (only claude or lazygit)', t => {
	// Hard-quit can leave just one of the pair behind. Each session is reaped
	// independently of whether its sibling is still alive.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: ['claude-repo-STA-999'].join('\n'),
	});
	t.is(cleanupOrphanedInnerSessions(new Set(), 'repo', runner), 1);
	const killed = calls.filter(c => c[0] === 'kill-session').map(c => c[2]);
	t.deepEqual(killed, ['claude-repo-STA-999']);
});
