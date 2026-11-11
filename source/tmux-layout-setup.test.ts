import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'ava';
import {PANE_TITLE_OPTION} from './pane-frame-options.ts';
import {resetRegistryPath, setRegistryPath} from './space-registry.ts';
import {
	SYNC_TERMINAL_FEATURE,
	setSpaceCompanionEnabled,
	setupPappardellLayout,
} from './tmux.ts';

const exec = promisify(execFile);

// The setup runs tmux through the process environment, as the TUI does from
// inside its pane, so each case points that environment at a server of its own.
async function isolatedPane(
	t: {teardown(fn: () => Promise<void> | void): void},
	width: number,
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-setup-'));
	const socket = path.join(dir, 'outer');
	const run = async (args: string[]) => {
		const {stdout} = await exec('tmux', ['-S', socket, ...args], {
			env: {...process.env, TMUX: ''},
			timeout: 5000,
		});
		return stdout.trim();
	};
	const saved = {
		TMUX: process.env['TMUX'],
		TMUX_PANE: process.env['TMUX_PANE'],
		TMUX_TMPDIR: process.env['TMUX_TMPDIR'],
	};
	setRegistryPath(path.join(dir, 'registry.json'));
	t.teardown(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}

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
		String(width),
		'-y',
		'50',
		';',
		'set-option',
		'-g',
		'status',
		'off',
	]);
	const listPaneId = await run(['display-message', '-p', '#{pane_id}']);
	process.env['TMUX'] = `${socket},0,0`;
	process.env['TMUX_PANE'] = listPaneId;
	// The inner socket is addressed by name, which resolves under this directory.
	process.env['TMUX_TMPDIR'] = dir;
	return {run, listPaneId};
}

async function tmuxAvailable() {
	try {
		await exec('tmux', ['-V']);
		return true;
	} catch {
		return false;
	}
}

test.serial(
	'a wide window is split into rail, agent and companion from left to right',
	async t => {
		if (!(await tmuxAvailable())) {
			t.pass('tmux unavailable');
			return;
		}

		const {run, listPaneId} = await isolatedPane(t, 200);
		const layout = await setupPappardellLayout();
		t.truthy(layout);
		const {agentViewerPaneId, companionViewerPaneId} = layout!;
		const panes = await run([
			'list-panes',
			'-t',
			listPaneId,
			'-F',
			`#{pane_id} #{pane_width} #{pane_active} #{${PANE_TITLE_OPTION}}`,
		]);
		const rows = panes.split('\n').map(line => line.split(' '));
		t.deepEqual(
			rows.map(([id, , active, title]) => [id, active, title]),
			[
				[listPaneId, '1', 'rail'],
				[agentViewerPaneId, '0', 'agent'],
				[companionViewerPaneId, '0', 'companion'],
			],
		);
		// Two dividers separate the three panes.
		t.is(
			rows.reduce((total, [, width]) => total + Number(width), 0),
			198,
		);
		t.is(
			await run([
				'show-options',
				'-wv',
				'-t',
				listPaneId,
				'pane-border-status',
			]),
			'off',
		);
		t.is(await run(['show-options', '-gv', 'focus-events']), 'on');
		const features = await run(['show-options', '-gqv', 'terminal-features']);
		t.true(features.split('\n').includes(SYNC_TERMINAL_FEATURE));
	},
);

test.serial(
	'a narrow window puts the agent below the rail with no companion',
	async t => {
		if (!(await tmuxAvailable())) {
			t.pass('tmux unavailable');
			return;
		}

		const {run, listPaneId} = await isolatedPane(t, 80);
		const layout = await setupPappardellLayout();
		t.is(layout?.companionViewerPaneId, '');
		const panes = await run([
			'list-panes',
			'-t',
			listPaneId,
			'-F',
			`#{pane_id} #{pane_width} #{pane_active} #{${PANE_TITLE_OPTION}}`,
		]);
		t.deepEqual(panes.split('\n'), [
			`${listPaneId} 80 1 rail`,
			`${layout!.agentViewerPaneId} 80 0 agent`,
		]);
	},
);

test.serial(
	'with the companion off a wide window has the rail and the agent only',
	async t => {
		if (!(await tmuxAvailable())) {
			t.pass('tmux unavailable');
			return;
		}

		const {run, listPaneId} = await isolatedPane(t, 200);
		setSpaceCompanionEnabled(false);
		t.teardown(() => {
			setSpaceCompanionEnabled(null);
		});
		const layout = await setupPappardellLayout();
		t.is(layout?.companionViewerPaneId, '');
		const panes = await run([
			'list-panes',
			'-t',
			listPaneId,
			'-F',
			`#{pane_id} #{pane_width} #{${PANE_TITLE_OPTION}}`,
		]);
		const rows = panes.split('\n').map(line => line.split(' '));
		t.deepEqual(
			rows.map(([id, , title]) => [id, title]),
			[
				[listPaneId, 'rail'],
				[layout!.agentViewerPaneId, 'agent'],
			],
		);
		// usable = 199: the rail keeps floor(199 * 0.24) = 47 → 40 (its cap).
		t.deepEqual(
			rows.map(([, width]) => Number(width)),
			[40, 159],
		);
	},
);
