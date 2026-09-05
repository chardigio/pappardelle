// Tests for the tmux synchronized-output (DEC 2026) opt-in that stops the TUI
// flickering while you type.
//
// Root cause, established by measurement against a real captured tmux client
// (`script -q ... tmux attach`): tmux only wraps a redraw in `ESC [ ? 2026 h/l`
// when it believes the client's terminal supports Sync, and it infers that from
// the client's TERM. Pappardelle's clients routinely report `tmux-256color`
// (nested tmux is this app's normal shape; the claude and companion panes each
// host a `tmux -L pappardelle_inner attach`), which advertises no Sync. With
// `terminal-features` left at tmux's defaults a typing burst produced 0
// synchronized updates downstream; with `*:Sync` appended the same burst
// produced 11. Unbatched repaints let the outer terminal present a half-drawn
// frame, which is the flicker.
//
// These tests don't exercise real tmux (that's integration-tests/). They lock
// down the argv shape, because the whole fix is one option and getting `-ga`
// wrong silently reintroduces the bug or destroys the user's config.
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'ava';
import {
	SYNC_TERMINAL_FEATURE,
	enableSynchronizedOutput,
	innerTmuxArgs,
	type OuterTmuxRunner,
} from './tmux.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMUX_SOURCE = readFileSync(join(__dirname, 'tmux.ts'), 'utf-8');

type Call = readonly string[];

type Outcome = {
	error?: Error;
	status: number | null;
	stdout: string;
};

const recorder = (
	result?: Outcome | ((args: Call) => Outcome),
): {calls: Call[]; runner: OuterTmuxRunner} => {
	const outcome = result ?? {status: 0, stdout: ''};
	const calls: Call[] = [];
	return {
		calls,
		runner(args) {
			calls.push(args);
			return typeof outcome === 'function' ? outcome(args) : outcome;
		},
	};
};

/** A runner whose `show-options` reports the given terminal-features entries. */
const withFeatures = (...entries: string[]) =>
	recorder(args =>
		args[0] === 'show-options'
			? {status: 0, stdout: entries.join('\n') + '\n'}
			: {status: 0, stdout: ''},
	);

const setOptionCalls = (calls: Call[]) =>
	calls.filter(args => args[0] === 'set-option');

test('sets terminal-features on both the outer and the inner socket', t => {
	const outer = recorder();
	const inner = recorder();

	enableSynchronizedOutput(outer.runner, inner.runner);

	const expected = [
		'set-option',
		'-ga',
		'terminal-features',
		`,${SYNC_TERMINAL_FEATURE}`,
	];
	t.deepEqual(setOptionCalls(outer.calls), [expected]);
	t.deepEqual(setOptionCalls(inner.calls), [expected]);
});

test('appends rather than assigns, so user-configured features survive', t => {
	// `set -g` would replace the whole option and silently drop whatever the
	// user configured in ~/.tmux.conf. `-a` with a leading comma is tmux's
	// documented way to add an array entry.
	const outer = recorder();
	enableSynchronizedOutput(outer.runner, recorder().runner);

	const [args] = setOptionCalls(outer.calls);
	t.true(args!.includes('-ga'), 'must append');
	t.false(args!.includes('-g'), 'must not use a bare assigning -g');
	t.true(
		args!.at(-1)!.startsWith(','),
		'leading comma is what makes tmux add a new array entry instead of concatenating onto the last one',
	);
});

test('the inner-socket call routes through innerTmuxArgs (keeps the -L flag)', t => {
	// The inner runner is the only thing that adds `-L pappardelle_inner`; this
	// pins that the argv we hand it is the un-prefixed form it expects, so the
	// socket flag can't end up doubled or missing.
	const inner = recorder();
	enableSynchronizedOutput(recorder().runner, inner.runner);

	t.deepEqual(innerTmuxArgs(setOptionCalls(inner.calls)[0]!), [
		'-L',
		'pappardelle_inner',
		'set-option',
		'-ga',
		'terminal-features',
		`,${SYNC_TERMINAL_FEATURE}`,
	]);
});

test('a failing or throwing tmux never breaks layout setup', t => {
	// This runs inside setupPappardellLayout. Synchronized output is a rendering
	// nicety; an old tmux that rejects the option must not cost the user their
	// panes.
	const failing: OuterTmuxRunner = () => ({status: 1, stdout: ''});
	const throwing: OuterTmuxRunner = () => {
		throw new Error('tmux not found');
	};

	t.notThrows(() => {
		enableSynchronizedOutput(failing, throwing);
	});
	t.notThrows(() => {
		enableSynchronizedOutput(throwing, failing);
	});
});

test('a failure on the outer socket still attempts the inner socket', t => {
	const throwing: OuterTmuxRunner = () => {
		throw new Error('tmux not found');
	};
	const inner = recorder();

	enableSynchronizedOutput(throwing, inner.runner);

	t.is(setOptionCalls(inner.calls).length, 1);
});

test('skips the append when the feature is already present', t => {
	// `-ga` is unconditional and `terminal-features` is server-scope, so without
	// this check every launch against a long-lived tmux server piles on another
	// copy: 19 `*:Sync` entries were observed on a live pappardelle_inner socket.
	// The duplicates don't change rendering (tmux unions the features) but they
	// make the option unreadable for exactly the color/redraw debugging it exists
	// to support.
	const outer = withFeatures('xterm*:clipboard', SYNC_TERMINAL_FEATURE);

	enableSynchronizedOutput(outer.runner, recorder().runner);

	t.deepEqual(setOptionCalls(outer.calls), []);
});

test('still appends when other features are configured but Sync is not', t => {
	const outer = withFeatures('xterm*:clipboard', '*:RGB');

	enableSynchronizedOutput(outer.runner, recorder().runner);

	t.is(setOptionCalls(outer.calls).length, 1);
});

test('the presence check reads the option from the same socket', t => {
	const inner = withFeatures();

	enableSynchronizedOutput(recorder().runner, inner.runner);

	t.deepEqual(inner.calls[0], ['show-options', '-gqv', 'terminal-features']);
});

test('each socket is checked independently', t => {
	// The outer and inner sockets are separate tmux servers with separate option
	// tables; one already carrying Sync says nothing about the other.
	const outer = withFeatures(SYNC_TERMINAL_FEATURE);
	const inner = withFeatures();

	enableSynchronizedOutput(outer.runner, inner.runner);

	t.deepEqual(setOptionCalls(outer.calls), []);
	t.is(setOptionCalls(inner.calls).length, 1);
});

test('appends when the presence check fails, rather than losing the feature', t => {
	// A duplicate entry is cosmetic; a missing one brings the flicker back. When
	// we can't read the option, prefer the old unconditional behaviour.
	const failing = recorder(args =>
		args[0] === 'show-options'
			? {status: 1, stdout: ''}
			: {status: 0, stdout: ''},
	);
	const throwing = recorder(args => {
		if (args[0] === 'show-options') {
			throw new Error('tmux not found');
		}

		return {status: 0, stdout: ''};
	});

	enableSynchronizedOutput(failing.runner, throwing.runner);

	t.is(setOptionCalls(failing.calls).length, 1);
	t.is(setOptionCalls(throwing.calls).length, 1);
});

test('a substring match does not count as the feature being present', t => {
	// `*:Sync` must match a whole array entry. tmux prints one entry per line, and
	// an entry like `xterm*:SyncSomething` is a different feature on a different
	// terminal pattern.
	const outer = withFeatures('xterm*:SyncSomething', 'foo*:Sync');

	enableSynchronizedOutput(outer.runner, recorder().runner);

	t.is(setOptionCalls(outer.calls).length, 1);
});

test('setupPappardellLayout enables synchronized output', t => {
	// The option is server-scope and only needs setting once per run, so it
	// piggybacks on layout setup alongside the other tmux set-options. Pinning
	// the call site keeps it from being dropped in a future refactor of that
	// function, which would bring the flicker back with no test failing.
	const layoutBody = TMUX_SOURCE.slice(
		TMUX_SOURCE.indexOf('export function setupPappardellLayout'),
	);
	t.true(
		layoutBody.includes('enableSynchronizedOutput()'),
		'setupPappardellLayout must call enableSynchronizedOutput()',
	);
});
