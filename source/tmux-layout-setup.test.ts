import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {PANE_FRAME_SIZE, PANE_TITLE_OPTION} from './pane-frame-options.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {
	INNER_SOCKET,
	SYNC_TERMINAL_FEATURE,
	reconcilePaneLayout,
	setupPappardellLayout,
} from './tmux.ts';

const exec = promisify(execFile);

// The setup runs tmux through the process environment, as the TUI does from
// inside its pane, so each case points that environment at a server of its own.
async function isolatedPane(width: number) {
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
	testTmuxState();
	teardown(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}

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
	return {run, listPaneId, tmuxTmpdir: dir};
}

// Unit tests run without the TUI's control clients, which start the inner
// server, so a held session stands in for them.
async function innerServer(tmuxTmpdir: string) {
	// A socket name resolves under TMUX_TMPDIR. Left to the environment, a
	// missing one would make this the developer's live inner server, which the
	// teardown kills.
	const env = {...process.env, TMUX: '', TMUX_TMPDIR: tmuxTmpdir};
	const run = async (args: string[]) => {
		const {stdout} = await exec('tmux', ['-L', INNER_SOCKET, ...args], {
			env,
			timeout: 5000,
		});
		return stdout.trim();
	};
	teardown(async () => {
		try {
			await run(['kill-server']);
		} catch {}
	});
	await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'held']);
	// Created detached, as idow's start-agent-session.sh creates a space's
	// sessions for a space nobody is viewing.
	const sizeOfNewSession = async (name: string) => {
		await run(['new-session', '-d', '-s', name]);
		return run([
			'display-message',
			'-p',
			'-t',
			`=${name}:`,
			'#{window_width}x#{window_height}',
		]);
	};
	return sizeOfNewSession;
}

async function viewerInnerSize(
	run: (args: string[]) => Promise<string>,
	paneId: string,
) {
	const size = await run([
		'display-message',
		'-p',
		'-t',
		paneId,
		'#{pane_width} #{pane_height}',
	]);
	const [cols, rows] = size.split(' ').map(Number);
	return `${cols! - PANE_FRAME_SIZE}x${rows! - PANE_FRAME_SIZE}`;
}

async function tmuxAvailable() {
	try {
		await exec('tmux', ['-V']);
		return true;
	} catch {
		return false;
	}
}

test('a wide window is split into rail, agent and companion from left to right', async () => {
	if (!(await tmuxAvailable())) {
		expect().pass('tmux unavailable');
		return;
	}

	const {run, listPaneId} = await isolatedPane(200);
	const layout = await setupPappardellLayout();
	expect(layout).toBeTruthy();
	const {agentViewerPaneId, companionViewerPaneId} = layout!;
	const panes = await run([
		'list-panes',
		'-t',
		listPaneId,
		'-F',
		`#{pane_id} #{pane_width} #{pane_active} #{${PANE_TITLE_OPTION}}`,
	]);
	const rows = panes.split('\n').map(line => line.split(' '));
	expect(
		rows.map(([id, , active, title]) => [id, active, title]),
	).toStrictEqual([
		[listPaneId, '1', 'rail'],
		[agentViewerPaneId, '0', 'agent'],
		[companionViewerPaneId, '0', 'companion'],
	]);
	// Two dividers separate the three panes.
	expect(rows.reduce((total, [, width]) => total + Number(width), 0)).toBe(198);
	expect(
		await run(['show-options', '-wv', '-t', listPaneId, 'pane-border-status']),
	).toBe('off');
	expect(await run(['show-options', '-gv', 'focus-events'])).toBe('on');
	const features = await run(['show-options', '-gqv', 'terminal-features']);
	expect(features.split('\n').includes(SYNC_TERMINAL_FEATURE)).toBe(true);
});

test('a narrow window puts the agent below the rail with no companion', async () => {
	if (!(await tmuxAvailable())) {
		expect().pass('tmux unavailable');
		return;
	}

	const {run, listPaneId} = await isolatedPane(80);
	const layout = await setupPappardellLayout();
	expect(layout?.companionViewerPaneId).toBe('');
	const panes = await run([
		'list-panes',
		'-t',
		listPaneId,
		'-F',
		`#{pane_id} #{pane_width} #{pane_active} #{${PANE_TITLE_OPTION}}`,
	]);
	expect(panes.split('\n')).toStrictEqual([
		`${listPaneId} 80 1 rail`,
		`${layout!.agentViewerPaneId} 80 0 agent`,
	]);
});

test("a session created after layout while not viewed starts at the agent viewer's inner size", async () => {
	if (!(await tmuxAvailable())) {
		expect().pass('tmux unavailable');
		return;
	}

	const {run, tmuxTmpdir} = await isolatedPane(200);
	const sizeOfNewSession = await innerServer(tmuxTmpdir);
	const layout = await setupPappardellLayout();
	expect(await sizeOfNewSession('unviewed')).toBe(
		await viewerInnerSize(run, layout!.agentViewerPaneId),
	);
});

test('a relayout moves later sessions to the new viewer size', async () => {
	if (!(await tmuxAvailable())) {
		expect().pass('tmux unavailable');
		return;
	}

	const {run, tmuxTmpdir} = await isolatedPane(200);
	const sizeOfNewSession = await innerServer(tmuxTmpdir);
	const layout = await setupPappardellLayout();
	const before = await viewerInnerSize(run, layout!.agentViewerPaneId);
	await run(['resize-window', '-t', 'fixture', '-x', '240', '-y', '60']);
	await reconcilePaneLayout(layout!, false);
	const after = await viewerInnerSize(run, layout!.agentViewerPaneId);
	expect(after).not.toBe(before);
	expect(await sizeOfNewSession('unviewed')).toBe(after);
});
