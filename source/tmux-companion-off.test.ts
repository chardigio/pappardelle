// The companion turned off and on again for the selected space (STA-3069), on
// an isolated tmux server. tmux.ts keeps the setting in module state, so the
// steps run in order in one test.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {
	rebuildLayout,
	reconcilePaneLayout,
	setSpaceCompanionEnabled,
} from './tmux.ts';
import {setRegistryPath, resetRegistryPath} from './space-registry.ts';

const exec = promisify(execFile);

test.serial(
	'a space with the companion off gets two panes, and one with it on gets three again',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}

		const dir = fs.mkdtempSync('/tmp/pco-');
		const socket = path.join(dir, 's');
		const run = async (args: string[]) => {
			const {stdout} = await exec('tmux', ['-S', socket, ...args], {
				env: {...process.env, TMUX: ''},
				timeout: 5000,
			});
			return stdout;
		};

		setRegistryPath(path.join(dir, 'registry.json'));
		t.teardown(async () => {
			setSpaceCompanionEnabled(null);
			try {
				await exec('tmux', ['-S', socket, 'kill-server']);
			} catch {}

			resetRegistryPath();
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
			'200',
			'-y',
			'50',
		]);
		await run(['set-option', '-g', 'status', 'off']);
		const paneOutput = await run(['display-message', '-p', '#{pane_id}']);
		const pane = paneOutput.trim();
		const widths = async () => {
			const output = await run([
				'list-panes',
				'-t',
				pane,
				'-F',
				'#{pane_width}',
			]);
			return output.trim().split('\n').map(Number);
		};

		setSpaceCompanionEnabled(true);
		const built = await rebuildLayout(pane, '', '', run);
		if (!built) {
			t.fail('layout');
			return;
		}

		let {layout} = built;
		t.not(layout.companionViewerPaneId, '');
		t.is(await widths().then(list => list.length), 3);

		// Unchanged: a relayout keeps the same panes.
		let reconciled = await reconcilePaneLayout(layout, false, run);
		t.is(reconciled.layout, layout);

		setSpaceCompanionEnabled(false);
		reconciled = await reconcilePaneLayout(layout, false, run);
		t.not(reconciled.layout, layout);
		layout = reconciled.layout;
		t.is(layout.companionViewerPaneId, '');
		t.deepEqual(await widths(), [40, 159]);

		// Off stays off without another rebuild.
		reconciled = await reconcilePaneLayout(layout, false, run);
		t.is(reconciled.layout, layout);

		setSpaceCompanionEnabled(true);
		reconciled = await reconcilePaneLayout(layout, false, run);
		t.not(reconciled.layout.companionViewerPaneId, '');
		t.is(await widths().then(list => list.length), 3);
	},
);
