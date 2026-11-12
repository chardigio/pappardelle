// Per-space companion widths in a relayout, on an isolated tmux server.
// tmux.ts keeps its overrides in module state, so the steps run in order in
// one test.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {
	rebuildLayout,
	reconcilePaneLayout,
	setSpaceCompanionDragHandler,
	setSpaceCompanionWidth,
} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';

const exec = promisify(execFile);

const paneWidth = async (
	paneId: string,
	run: (args: string[]) => Promise<string>,
) =>
	Number(await run(['display-message', '-p', '-t', paneId, '#{pane_width}']));

test.serial(
	'a space width applies while set, takes drags for its own space, and leaves the global drag override alone',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}

		const dir = fs.mkdtempSync('/tmp/psw-');
		const socket = path.join(dir, 's');
		const run = async (args: string[]) => {
			const {stdout} = await exec('tmux', ['-S', socket, ...args], {
				env: {...process.env, TMUX: ''},
				timeout: 5000,
			});
			return stdout;
		};

		testTmuxState(t);
		t.teardown(async () => {
			setSpaceCompanionDragHandler(null);
			setSpaceCompanionWidth(null);
			try {
				await exec('tmux', ['-S', socket, 'kill-server']);
			} catch {}

			fs.rmSync(dir, {recursive: true, force: true});
		});

		await run([
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-s',
			'fixture',
			'-x',
			'220',
			'-y',
			'50',
		]);
		await run(['set-option', '-g', 'status', 'off']);
		const paneOutput = await run(['display-message', '-p', '#{pane_id}']);
		const pane = paneOutput.trim();
		const rebuilt = await rebuildLayout(pane, '', '', run);
		const layout = rebuilt?.layout;
		if (!layout) {
			t.fail('layout');
			return;
		}

		const companion = layout.companionViewerPaneId;
		const width = async () => paneWidth(companion, run);
		const drags: Array<[string, number]> = [];
		setSpaceCompanionDragHandler((key, columns) => drags.push([key, columns]));

		await reconcilePaneLayout(layout, false, run);
		const derived = await width();

		setSpaceCompanionWidth({key: 'A', width: 50});
		await reconcilePaneLayout(layout, false, run);
		t.is(await width(), 50);

		setSpaceCompanionWidth(null);
		await reconcilePaneLayout(layout, false, run);
		t.is(await width(), derived);

		// A drag on A is A's even when the selection moves to B before the
		// relayout that notices it finishes.
		setSpaceCompanionWidth({key: 'A', width: 50});
		await reconcilePaneLayout(layout, false, run);
		await run(['resize-pane', '-t', companion, '-x', '70']);
		let switched = false;
		const switching = async (args: string[]) => {
			if (!switched) {
				switched = true;
				setSpaceCompanionWidth({key: 'B', width: 40});
			}

			return run(args);
		};

		await reconcilePaneLayout(layout, false, switching);
		t.deepEqual(drags, [['A', 70]]);
		t.is(await width(), 40);

		// With no space width, a drag is the session-wide override, as before.
		setSpaceCompanionWidth(null);
		await reconcilePaneLayout(layout, false, run);
		await run(['resize-pane', '-t', companion, '-x', '64']);
		await reconcilePaneLayout(layout, false, run);
		await reconcilePaneLayout(layout, false, run);
		t.is(await width(), 64);
		t.deepEqual(drags, [['A', 70]]);
	},
);
