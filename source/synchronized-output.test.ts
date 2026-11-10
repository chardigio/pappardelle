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
// The whole fix is one option, and getting `-ga` wrong silently reintroduces
// the bug or destroys the user's config.
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'ava';
import {
	SYNC_TERMINAL_FEATURE,
	enableInnerSynchronizedOutput,
	synchronizedOutputArgs,
} from './tmux.ts';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TMUX_SOURCE = readFileSync(join(__dirname, 'tmux.ts'), 'utf-8');

test('appends rather than assigns, so user-configured features survive', t => {
	// `set -g` would replace the whole option and silently drop whatever the
	// user configured in ~/.tmux.conf. `-a` with a leading comma is tmux's
	// documented way to add an array entry instead of concatenating onto the
	// last one.
	const [command, flag, , whenPresent, whenAbsent] = synchronizedOutputArgs();
	t.deepEqual([command, flag], ['if-shell', '-F']);
	t.is(whenPresent, '');
	t.is(
		whenAbsent,
		`set-option -ga terminal-features ',${SYNC_TERMINAL_FEATURE}'`,
	);
});

test('the inner-socket call keeps the -L flag', async t => {
	const calls: string[][] = [];
	await enableInnerSynchronizedOutput(async args => {
		calls.push(args);
		return '';
	});

	t.deepEqual(calls, [
		['-L', 'pappardelle_inner', ...synchronizedOutputArgs()],
	]);
});

test('a failing tmux never breaks layout setup', async t => {
	// This runs inside setupPappardellLayout. Synchronized output is a rendering
	// nicety; an old tmux that rejects the option must not cost the user their
	// panes.
	await t.notThrowsAsync(
		enableInnerSynchronizedOutput(async () => {
			throw new Error('tmux not found');
		}),
	);
});

test.serial(
	'real tmux adds the feature once, and only a whole entry counts as present',
	async t => {
		// `terminal-features` is server-scope, so an unguarded append piles on
		// another copy with every launch against a long-lived server: 19 `*:Sync`
		// entries were observed on a live pappardelle_inner socket. `*:Sync` must
		// match a whole array entry, because `foo*:Sync` is the same feature on a
		// different terminal pattern.
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), 'papp-sync-'));
		const socket = join(dir, 'server');
		const run = async (args: string[]) => {
			const {stdout} = await exec('tmux', ['-S', socket, ...args], {
				env: {...process.env, TMUX: ''},
				timeout: 5000,
			});
			return stdout;
		};
		t.teardown(async () => {
			try {
				await exec('tmux', ['-S', socket, 'kill-server']);
			} catch {}

			rmSync(dir, {recursive: true, force: true});
		});
		await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture']);
		await run([
			'set-option',
			'-ga',
			'terminal-features',
			',xterm*:SyncSomething,foo*:Sync',
		]);
		const entries = async () => {
			const features = await run(['show-options', '-gqv', 'terminal-features']);
			return features
				.split('\n')
				.filter(line => line.trim() === SYNC_TERMINAL_FEATURE).length;
		};

		t.is(await entries(), 0);
		await run(synchronizedOutputArgs());
		t.is(await entries(), 1);
		await run(synchronizedOutputArgs());
		t.is(await entries(), 1);
	},
);

test('setupPappardellLayout enables synchronized output on both sockets', t => {
	// The option is server-scope and only needs setting once per run, so it
	// piggybacks on layout setup alongside the other tmux set-options. Pinning
	// the call sites keeps them from being dropped in a future refactor of that
	// function, which would bring the flicker back with no test failing.
	const layoutBody = TMUX_SOURCE.slice(
		TMUX_SOURCE.indexOf('export async function setupPappardellLayout'),
	);
	for (const call of [
		'...synchronizedOutputArgs()',
		'enableInnerSynchronizedOutput()',
	])
		t.not(layoutBody.indexOf(call), -1);
});
