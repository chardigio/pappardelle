// Tests for the inner-socket routing that isolates per-issue claude/companion
// sessions onto `tmux -L pappardelle_inner`. See STA-860.
//
// The point of these tests is not to exercise real tmux (that belongs in the
// integration-tests/ directory) — it's to lock down the argv shape the
// TypeScript layer builds. Specifically: every inner-session call site must
// route through a single helper so a future caller that forgets the `-L` flag
// fails CI rather than silently regressing nested-tmux behavior.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect, beforeAll, afterAll} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {testTmuxState, type TestState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	sessionNamesFor,
	sessionPrefix,
	type ProtectedSessions,
} from './space-identity.ts';
import {
	INNER_SOCKET,
	cleanupOrphanedInnerSessions,
	initTmuxState,
	migrateLegacyAgentSessions,
	sharedSessionListingRunner,
	cleanupOrphanedOuterSessions,
	exactSessionTarget,
	innerTmuxArgs,
	type OuterTmuxRunner,
} from './tmux.ts';

// Reaping a space's sessions also removes its status snapshots, which the
// stores place.
const stateTeardowns: Array<() => unknown> = [];
let state: TestState;
beforeAll(() => {
	state = testTmuxState({cleanup: fn => stateTeardowns.push(fn)});
});
afterAll(async () => {
	for (const step of stateTeardowns.reverse()) await step();
});

/** These spaces and main, protected under the names idow gives them. */
function stored(keys: string[] = [], repo = 'repo'): ProtectedSessions {
	const owned = ['main', ...keys];
	return {
		keys: new Set(owned),
		names: new Set(
			owned.flatMap(key => {
				const names = sessionNamesFor(key, repo);
				return [names.agent, names.companion];
			}),
		),
	};
}

const NOTHING: ProtectedSessions = {names: new Set(), keys: new Set()};

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMUX_SOURCE = readFileSync(join(__dirname, 'tmux.ts'), 'utf-8');

test('INNER_SOCKET is pappardelle_inner', () => {
	expect(INNER_SOCKET).toBe('pappardelle_inner');
});

test('innerTmuxArgs prefixes -L INNER_SOCKET', () => {
	expect(
		innerTmuxArgs(['has-session', '-t', 'claude-repo-STA-1']),
	).toStrictEqual([
		'-L',
		'pappardelle_inner',
		'has-session',
		'-t',
		'claude-repo-STA-1',
	]);
});

test('innerTmuxArgs with empty args still includes -L prefix', () => {
	expect(innerTmuxArgs([])).toStrictEqual(['-L', 'pappardelle_inner']);
});

test('innerTmuxArgs does not mutate the input array', () => {
	const input = ['list-sessions'];
	innerTmuxArgs(input);
	expect(input).toStrictEqual(['list-sessions']);
});

// ============================================================================
// Call-site regression guards
//
// These scan the tmux.ts source to assert that inner-session operations are
// *always* routed through innerTmuxArgs / innerSessionExists / innerKillSession
// (and not via a bare `tmux ...` invocation that targets the default socket).
// If a future patch adds a call site that forgets the socket, these tests fail.
// ============================================================================

// The companion and its splits share one new-session builder, which the
// companion runs through innerTmuxArgs and a split through the inner runner.
const COMPANION_BUILDER =
	/function companionSessionArgs\([^]*?\n}\n/.exec(TMUX_SOURCE)?.[0] ?? '';

test('new-session for per-issue sessions routes through innerTmuxArgs', () => {
	expect(TMUX_SOURCE).toMatch(/innerTmuxArgs\(\[\s*['"]new-session['"]/);
	expect(TMUX_SOURCE).toMatch(/innerTmuxArgs\(\s*companionSessionArgs\(/);
	expect(TMUX_SOURCE).toMatch(
		/runner = options\.runner \?\? defaultInnerTmuxRunner;[^]*?companionSessionArgs\(/,
	);
});

test('every per-issue new-session carries the space session environment', () => {
	// A Claude started by hand in the pane reports its status under
	// PAPPARDELLE_SPACE, so a session the TUI makes must carry it just like one
	// start-agent-session.sh makes. Without it, the fix from
	// chardigio/pappardelle#22 holds only until the next reboot.
	const agent =
		TMUX_SOURCE.match(/innerTmuxArgs\(\[\s*['"]new-session['"][^\]]*\]/g) ?? [];
	expect(agent.length).toBe(1);
	expect(agent[0]!.includes('...spaceSessionEnvArgs(issueKey)')).toBe(true);
	expect(
		COMPANION_BUILDER.includes('...spaceSessionEnvArgs(issueKey, repoName)'),
	).toBe(true);
});

test('companion session launches the configurable command, never a hardcoded git UI', () => {
	// STA-1464: the companion pane runs `companionCommand` (resolved from
	// config, default gitui) — not a hardcoded tool. Guard against a regression
	// that reintroduces a literal `lazygit`/`gitui` invocation here.
	expect(
		TMUX_SOURCE,
		'ensureCompanionSession must launch the companionCommand variable',
	).toMatch(
		/companionSessionArgs\(\s*issueKey,\s*sessionName,\s*worktreePath,\s*companionCommand,?\s*\)/,
	);
	expect(COMPANION_BUILDER).toMatch(/buildShellLaunchArgs\(command\)/);
	expect(
		TMUX_SOURCE,
		'the companion command must come from config (DEFAULT_COMPANION_COMMAND lives in config.ts), not a tmux.ts literal',
	).not.toMatch(/GIT_OPTIONAL_LOCKS=0 (lazygit|gitui)/);
});

test('companion session launches nothing when the command is empty (plain shell)', () => {
	// An empty companion_command means "leave a plain shell", so the session
	// must be created with tmux's default shell rather than a launch wrapper.
	expect(
		COMPANION_BUILDER,
		'the companion builder must skip the launch args for an empty command',
	).toMatch(/command\.trim\(\)\s*===\s*''\s*\?\s*\[\]/);
});

test('no bare `tmux new-session -d` survives for per-issue sessions', () => {
	// The only new-session call that is allowed to skip the inner socket is the
	// outer `pappardelle-{repo}` root session in cli.tsx. Inside tmux.ts, every
	// new-session call must go through innerTmuxArgs.
	const bareDetachedNewSession = TMUX_SOURCE.match(
		/spawnSync\(\s*['"]tmux['"]\s*,\s*\[\s*['"]new-session['"]\s*,\s*['"]-d['"]/g,
	);
	expect(
		bareDetachedNewSession,
		'tmux.ts must not call `tmux new-session -d` directly; route via innerTmuxArgs',
	).toBe(null);
});

test('switch-client and list-clients route through innerTmuxArgs', () => {
	// Nested clients live on the inner socket, so both list-clients and
	// switch-client need the -L prefix.
	expect(
		TMUX_SOURCE,
		'list-clients must be routed through innerTmuxArgs',
	).toMatch(/innerTmuxArgs\(\[\s*['"]list-clients['"]/);
	expect(
		TMUX_SOURCE,
		'switch-client must be routed through innerTmuxArgs',
	).toMatch(/innerTmuxArgs\(\[\s*['"]switch-client['"]/);
});

test('has-session via spawnSync routes through innerTmuxArgs', () => {
	// The outer pappardelle-{repo} session's `has-session` goes through
	// defaultOuterTmuxRunner. Every spawnSync form must route through
	// innerTmuxArgs — a bare `spawnSync('tmux', ['has-session', ...])` would
	// silently target the default socket and miss per-issue sessions.
	const bareHasSession = TMUX_SOURCE.match(
		/spawnSync\(\s*['"]tmux['"]\s*,\s*\[\s*['"]has-session['"]/g,
	);
	expect(
		bareHasSession,
		'has-session spawnSync calls must go through innerTmuxArgs; the outer `pappardelle-{repo}` session uses defaultOuterTmuxRunner',
	).toBe(null);
	expect(
		TMUX_SOURCE,
		'innerSessionExists must route has-session through innerTmuxArgs',
	).toMatch(/innerTmuxArgs\(\[\s*['"]has-session['"]/);
});

test('session lookups and kills by name use exact targets', () => {
	// A bare name falls back to tmux prefix matching when no session has it
	// exactly, so checking or killing STA-1 would hit STA-12.
	expect(TMUX_SOURCE).toMatch(
		/innerTmuxArgs\(\[\s*'has-session',\s*'-t',\s*exactSessionTarget\(/,
	);
	expect(TMUX_SOURCE).toMatch(
		/innerTmuxArgs\(\[\s*'kill-session',\s*'-t',\s*exactSessionTarget\(/,
	);
	expect(TMUX_SOURCE).toMatch(
		/defaultOuterTmuxRunner\(\[\s*'has-session',\s*'-t',\s*exactSessionTarget\(/,
	);
	expect(TMUX_SOURCE).toMatch(
		/defaultOuterTmuxRunner\(\[\s*'kill-session',\s*'-t',\s*exactSessionTarget\(/,
	);
});

test('exactSessionTarget stops tmux prefix-matching another session', () => {
	// -S rather than -L: a named socket lands in /tmp/tmux-<uid>, outside TMPDIR.
	const socket = join(tempDir('pappardelle-exact-'), 's');
	const tmux = (...args: string[]) =>
		spawnSync('tmux', ['-S', socket, ...args], {encoding: 'utf-8'});
	if (tmux('-V').error) {
		expect().pass('tmux not installed');
		return;
	}

	try {
		expect(tmux('new-session', '-d', '-s', 'agent-repo-STA-12').status).toBe(0);
		expect(tmux('has-session', '-t', 'agent-repo-STA-1').status).toBe(0);
		expect(
			tmux('has-session', '-t', exactSessionTarget('agent-repo-STA-1')).status,
		).not.toBe(0);
		// tmux 3.6 and older store a '.' as '_', so a name built with a dotted
		// repo must already be in that spelling to be found again.
		const dotted = `${sessionPrefix('agent', 'my.repo')}STA-1`;
		expect(tmux('new-session', '-d', '-s', dotted).status).toBe(0);
		expect(tmux('has-session', '-t', exactSessionTarget(dotted)).status).toBe(
			0,
		);
	} finally {
		tmux('kill-server');
	}
});

test('kill-session for per-issue sessions routes through innerTmuxArgs', () => {
	// `innerKillSession` must route kill-session through innerTmuxArgs.
	// `cleanupOrphanedOuterSessions` intentionally bypasses this — it targets
	// the default socket to drop pre-STA-860 leftovers — but it's the only
	// permitted exception.
	expect(
		TMUX_SOURCE,
		'innerKillSession must route kill-session through innerTmuxArgs',
	).toMatch(/innerTmuxArgs\(\[\s*['"]kill-session['"]/);

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
	expect(
		bareKillSession,
		'kill-session spawnSync calls must go through innerTmuxArgs or the injectable OuterTmuxRunner',
	).toBe(null);
});

test('pappardelle send resolves and pastes on the inner socket by default', () => {
	// sendToSpaceAgent and resolveInnerSessionTarget accept a runner for tests;
	// production must default to the inner-socket runner or relays land on the
	// default socket, where no per-issue session exists.
	expect(TMUX_SOURCE).toMatch(
		/const defaultInnerSendRunner = spawnTmuxRunnerAsync\(innerTmuxArgs\)/,
	);
	expect(TMUX_SOURCE).toMatch(
		/export async function resolveInnerSessionTarget\([^)]*runner: SendTmuxRunner = defaultInnerSendRunner/,
	);
	expect(TMUX_SOURCE).toMatch(
		/export async function sendToSpaceAgent[\s\S]*?options\.runner \?\? defaultInnerSendRunner/,
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
	/** Each session's PAPPARDELLE_SPACE. */
	spaces?: Record<string, string>;
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
		if (args[0] === 'show-environment') {
			const space = options.spaces?.[(args[2] ?? '').slice(1, -1)];
			return space === undefined
				? {status: 1, stdout: ''}
				: {status: 0, stdout: `PAPPARDELLE_SPACE=${space}\n`};
		}
		return {status: 0, stdout: ''};
	};
	return {runner, calls};
}

test('cleanupOrphanedOuterSessions returns 0 when no sessions match', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: 'pappardelle-repo\nsome-other-session\n',
	});
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(0);
	// Should list but never kill.
	expect(calls.length).toBe(1);
	expect(calls[0]).toStrictEqual(['list-sessions', '-F', '#{session_name}']);
});

test('cleanupOrphanedOuterSessions returns 0 when list-sessions errors', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStatus: 1,
		listSessionsStdout: '',
	});
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(0);
	expect(calls.length).toBe(1); // no kill attempts
});

test('cleanupOrphanedOuterSessions returns 0 when list-sessions throws', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsError: new Error('tmux not found'),
	});
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(0);
	expect(calls.length).toBe(1);
});

test('cleanupOrphanedOuterSessions only kills claude-{repo}-* / companion-{repo}-*', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'pappardelle-repo', // outer root — keep
			'claude-repo-STA-1', // kill
			'companion-repo-STA-1', // kill
			'claude-otherrepo-STA-2', // different repo — keep
			'claude-repo-foo', // kill (matches prefix even without issue-key shape)
			'unrelated-session', // keep
		].join('\n'),
	});
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(3);

	const killed = calls
		.filter(c => c[0] === 'kill-session')
		.map(c => c[2] ?? '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	expect(killed).toStrictEqual([
		'=claude-repo-STA-1:',
		'=claude-repo-foo:',
		'=companion-repo-STA-1:',
	]);
});

test('cleanupOrphanedOuterSessions sweeps legacy lazygit-{repo}-* sessions (STA-1464 upgrade)', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'pappardelle-repo', // outer root — keep
			'companion-repo-STA-1', // kill (new name)
			'lazygit-repo-STA-1', // kill (pre-STA-1464 companion name)
			'lazygit-otherrepo-STA-2', // different repo — keep
			'unrelated-session', // keep
		].join('\n'),
	});
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(2);

	const killed = calls
		.filter(c => c[0] === 'kill-session')
		.map(c => c[2] ?? '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	expect(killed).toStrictEqual([
		'=companion-repo-STA-1:',
		'=lazygit-repo-STA-1:',
	]);
});

test('cleanupOrphanedOuterSessions counts only successful kills', () => {
	const {runner} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'claude-repo-STA-2',
			'companion-repo-STA-1',
		].join('\n'),
		killStatus: name => (name === '=claude-repo-STA-2:' ? 1 : 0),
	});
	// 3 matched orphans, 1 kill fails → return 2.
	expect(cleanupOrphanedOuterSessions('repo', runner)).toBe(2);
});

// ============================================================================
// cleanupOrphanedInnerSessions
//
// STA-1420 Layer 2: symmetric to cleanupOrphanedOuterSessions but on the
// inner socket. Reaps `claude-{repo}-*` / `companion-{repo}-*` (and legacy
// `lazygit-{repo}-*`) sessions whose
// key is NOT in the registry and isn't the main worktree, which is what
// hard-quit (SIGKILL, terminal close, Ctrl-C mid-deinit) leaves behind now
// that STA-1416 removed seedFromTmux. Without this, orphans accumulate
// silently on the inner socket forever.
//
// `'main'` is the hardcoded key for the main worktree row (see app.tsx) — its
// sessions are legitimate and must never be reaped.
// ============================================================================

test("reaping a space's sessions clears its program status unless one of them survived", () => {
	const removed: string[] = [];
	initTmuxState({
		...state.daos,
		programStatus: {
			...state.daos.programStatus,
			async remove(key) {
				removed.push(key);
			},
		},
	});
	teardown(() => {
		initTmuxState(state.daos);
	});
	const {runner} = makeFakeRunner({
		listSessionsStdout: [
			'agent-repo-gone',
			'companion-repo-gone~tests',
			'agent-repo-stuck',
			'companion-repo-stuck',
			'agent-repo-unnamed',
			'agent-repo-stray',
		].join('\n'),
		// No stored identity names these spaces: their own sessions do.
		spaces: {
			'agent-repo-gone': 'GONE-1',
			'companion-repo-gone~tests': 'GONE-1',
			'agent-repo-stuck': 'STUCK-1',
			'companion-repo-stuck': 'STUCK-1',
			// A session of STA-1, which is open, under a name not stored for it.
			'agent-repo-stray': 'STA-1',
		},
		killStatus: name => (name === '=companion-repo-stuck:' ? 1 : 0),
	});
	expect(cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', runner)).toBe(
		5,
	);
	expect(removed).toStrictEqual(['GONE-1']);
});

test('cleanupOrphanedInnerSessions returns 0 when no sessions match', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: 'pappardelle-repo\nsome-other-session\n',
	});
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(0);
	expect(calls.length).toBe(1);
	expect(calls[0]).toStrictEqual(['list-sessions', '-F', '#{session_name}']);
});

test('cleanupOrphanedInnerSessions returns 0 when list-sessions errors', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStatus: 1,
		listSessionsStdout: '',
	});
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(0);
	expect(calls.length).toBe(1);
});

test('cleanupOrphanedInnerSessions returns 0 when list-sessions throws', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsError: new Error('tmux not found'),
	});
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(0);
	expect(calls.length).toBe(1);
});

test('cleanupOrphanedInnerSessions keeps the splits of a registered space and reaps a closed one', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'companion-repo-STA-1~tests',
			'companion-repo-STA-999~tests',
			'companion-repo-main~logs',
		].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', runner)).toBe(
		1,
	);
	expect(
		calls.filter(c => c[0] === 'kill-session').map(c => c[2]),
	).toStrictEqual(['=companion-repo-STA-999~tests:']);
});

test('cleanupOrphanedInnerSessions kills orphans (not in registry, not main)', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1', // registered → keep
			'companion-repo-STA-1', // registered → keep
			'claude-repo-STA-999', // orphan → kill
			'companion-repo-STA-999', // orphan → kill
			'claude-repo-main', // main worktree → keep
			'companion-repo-main', // main worktree → keep
			'claude-otherrepo-STA-2', // different repo → keep
			'pappardelle-repo', // outer root → keep
		].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', runner)).toBe(
		2,
	);

	const killed = calls
		.filter(c => c[0] === 'kill-session')
		.map(c => c[2] ?? '')
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	expect(killed).toStrictEqual([
		'=claude-repo-STA-999:',
		'=companion-repo-STA-999:',
	]);
});

test('cleanupOrphanedInnerSessions leaves a sibling repo named with this one as its prefix alone', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'agent-proj-x-STA-1', // proj-x's live space → keep
			'companion-proj-x-STA-1',
			'agent-proj-STA-9', // proj's orphan → kill
		].join('\n'),
	});
	expect(
		cleanupOrphanedInnerSessions(stored([], 'proj'), 'proj', runner, [
			'proj',
			'proj-x',
		]),
	).toBe(1);
	expect(
		calls.filter(c => c[0] === 'kill-session').map(c => c[2]),
	).toStrictEqual(['=agent-proj-STA-9:']);
});

test('cleanupOrphanedInnerSessions knows a sibling repo by its tmux spelling', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'agent-a_b-c-STA-1', // a_b-c's live space → keep
			'agent-a_b-STA-9', // a.b's orphan → kill
		].join('\n'),
	});
	expect(
		cleanupOrphanedInnerSessions(stored([], 'a.b'), 'a.b', runner, [
			'a.b',
			'a_b-c',
		]),
	).toBe(1);
	expect(
		calls.filter(c => c[0] === 'kill-session').map(c => c[2]),
	).toStrictEqual(['=agent-a_b-STA-9:']);
});

test('cleanupOrphanedInnerSessions keeps a stored session whatever its name, and what it owns', () => {
	// The names are stored when a space is created, so a kept session is found
	// by its name, never by a key read back out of it.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'agent-repo-hand.named', // stored → keep
			'claude-repo-hand.named', // its legacy name → keep
			'companion-repo-other~tests', // a split of a stored companion → keep
			'agent-repo-bd-a3f8e9_1', // the encoding of a key no row names → kill
		].join('\n'),
	});
	expect(
		cleanupOrphanedInnerSessions(
			{
				names: new Set(['agent-repo-hand.named', 'companion-repo-other']),
				keys: new Set(),
			},
			'repo',
			runner,
		),
	).toBe(1);

	const killed = calls.filter(c => c[0] === 'kill-session').map(c => c[2]);
	expect(killed).toStrictEqual(['=agent-repo-bd-a3f8e9_1:']);
});

test('cleanupOrphanedInnerSessions reaps main once main is not among the stored names', () => {
	const {runner} = makeFakeRunner({
		listSessionsStdout: ['agent-repo-main', 'companion-repo-main'].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(NOTHING, 'repo', runner)).toBe(2);
});

test('cleanupOrphanedInnerSessions sweeps legacy lazygit-{repo}-* orphans (STA-1464 upgrade)', () => {
	// A hard-quit straddling the STA-1464 upgrade can leave the old
	// `lazygit-{repo}-*` companion sessions behind on the inner socket. They
	// must be reaped on the same not-registered / not-main terms as the new
	// `companion-{repo}-*` name. Mirrors the outer-socket legacy-sweep test.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'lazygit-repo-STA-1', // registered → keep
			'lazygit-repo-STA-999', // orphan → kill
			'lazygit-repo-main', // main worktree → keep
			'lazygit-otherrepo-STA-2', // different repo → keep
			'pappardelle-repo', // outer root → keep
		].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', runner)).toBe(
		1,
	);

	const killed = calls.filter(c => c[0] === 'kill-session').map(c => c[2]);
	expect(killed).toStrictEqual(['=lazygit-repo-STA-999:']);
});

test('cleanupOrphanedInnerSessions never touches main-worktree sessions', () => {
	// Empty registry — only main sessions exist. None should be killed.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: ['claude-repo-main', 'companion-repo-main'].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(0);
	const killAttempts = calls.filter(c => c[0] === 'kill-session');
	expect(killAttempts.length).toBe(0);
});

test('cleanupOrphanedInnerSessions counts only successful kills', () => {
	const {runner} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'claude-repo-STA-2',
			'companion-repo-STA-1',
		].join('\n'),
		killStatus: name => (name === '=claude-repo-STA-2:' ? 1 : 0),
	});
	// 3 orphans (empty registry), 1 kill fails → return 2.
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(2);
});

test('cleanupOrphanedInnerSessions handles a partial pair (only claude or companion)', () => {
	// Hard-quit can leave just one of the pair behind. Each session is reaped
	// independently of whether its sibling is still alive.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: ['claude-repo-STA-999'].join('\n'),
	});
	expect(cleanupOrphanedInnerSessions(stored(), 'repo', runner)).toBe(1);
	const killed = calls.filter(c => c[0] === 'kill-session').map(c => c[2]);
	expect(killed).toStrictEqual(['=claude-repo-STA-999:']);
});

// ============================================================================
// migrateLegacyAgentSessions
//
// The agent-pane sessions were renamed from `claude-{repo}-{key}` to
// `agent-{repo}-{key}`. Live legacy sessions are renamed in place at
// startup (a rename preserves panes and running processes) so an in-flight
// conversation survives the upgrade instead of being orphaned or reaped.
// ============================================================================

test('migrateLegacyAgentSessions renames claude-{repo}-* to agent-{repo}-*', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'claude-repo-main',
			'companion-repo-STA-1', // companion prefix unchanged → untouched
			'claude-otherrepo-STA-2', // different repo → untouched
			'agent-repo-STA-3', // already migrated → untouched
		].join('\n'),
	});
	expect(migrateLegacyAgentSessions('repo', runner)).toBe(2);

	const renames = calls
		.filter(c => c[0] === 'rename-session')
		.map(c => [c[2], c[3]]);
	// `=` forces an exact target; a bare name would let tmux prefix-match
	// another space's session (STA-1 → STA-12).
	expect(renames).toStrictEqual([
		['=claude-repo-STA-1:', 'agent-repo-STA-1'],
		['=claude-repo-main:', 'agent-repo-main'],
	]);
});

test('migrateLegacyAgentSessions kills a legacy session whose agent name is taken', () => {
	// The agent- session is the one pappardelle attaches; the legacy duplicate
	// would otherwise survive every orphan reap because its key is registered.
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-STA-1',
			'agent-repo-STA-1',
			'claude-repo-STA-2',
		].join('\n'),
	});
	expect(migrateLegacyAgentSessions('repo', runner)).toBe(1);
	expect(
		calls.filter(c => c[0] === 'kill-session').map(c => c[2]),
	).toStrictEqual(['=claude-repo-STA-1:']);
	expect(
		calls.filter(c => c[0] === 'rename-session').map(c => [c[2], c[3]]),
	).toStrictEqual([['=claude-repo-STA-2:', 'agent-repo-STA-2']]);
});

test("migrateLegacyAgentSessions leaves a sibling repo's sessions alone", () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStdout: [
			'claude-repo-x-STA-1',
			'claude-repo-x-STA-2',
			'agent-repo-x-STA-2',
		].join('\n'),
	});
	expect(migrateLegacyAgentSessions('repo', runner, ['repo', 'repo-x'])).toBe(
		0,
	);
	expect(calls.filter(c => c[0] !== 'list-sessions')).toStrictEqual([]);
});

test('migrateLegacyAgentSessions returns 0 when list-sessions errors', () => {
	const {runner, calls} = makeFakeRunner({
		listSessionsStatus: 1,
		listSessionsStdout: '',
	});
	expect(migrateLegacyAgentSessions('repo', runner)).toBe(0);
	expect(calls.length).toBe(1);
});

// A fake inner server whose session list follows renames and kills.
function fakeInnerServer(initial: string[]) {
	let sessions = [...initial];
	const calls: string[][] = [];
	const named = (target: string) => target.replace(/^=/, '').replace(/:$/, '');
	const runner: OuterTmuxRunner = args => {
		calls.push([...args]);
		const target = named(args[args.indexOf('-t') + 1] ?? '');
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		if (args[0] === 'rename-session')
			sessions = sessions.map(name => (name === target ? args.at(-1)! : name));
		if (args[0] === 'kill-session')
			sessions = sessions.filter(name => name !== target);
		return {status: 0, stdout: ''};
	};
	return {runner, calls, sessions: () => sessions};
}

const listings = (calls: string[][]) =>
	calls.filter(args => args[0] === 'list-sessions').length;

test('startup maintenance lists the inner sessions once when the migration changes nothing', () => {
	const server = fakeInnerServer(['agent-repo-STA-1', 'agent-repo-STA-2']);
	const shared = sharedSessionListingRunner(server.runner);

	expect(migrateLegacyAgentSessions('repo', shared, ['repo'])).toBe(0);
	expect(
		cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', shared, ['repo']),
	).toBe(1);

	expect(listings(server.calls)).toBe(1);
	expect(server.sessions()).toStrictEqual(['agent-repo-STA-1']);
});

test('the reaping pass sees a session the migration just renamed', () => {
	// A listing taken before the rename still names the legacy session, and the
	// reap would then target a session that no longer exists.
	const server = fakeInnerServer(['claude-repo-STA-9', 'agent-repo-STA-1']);
	const shared = sharedSessionListingRunner(server.runner);

	expect(migrateLegacyAgentSessions('repo', shared, ['repo'])).toBe(1);
	expect(server.sessions()).toStrictEqual([
		'agent-repo-STA-9',
		'agent-repo-STA-1',
	]);
	expect(
		cleanupOrphanedInnerSessions(stored(['STA-1']), 'repo', shared, ['repo']),
	).toBe(1);

	expect(listings(server.calls)).toBe(2);
	expect(server.sessions()).toStrictEqual(['agent-repo-STA-1']);
});
