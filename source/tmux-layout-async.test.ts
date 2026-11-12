import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'ava';
import {rebuildLayout, reconcilePaneLayout} from './tmux.ts';
import {testTmuxState} from '../test/helpers/state.ts';

const exec = promisify(execFile);

async function getPaneDimensions(
	pane: string,
	run: (args: string[]) => Promise<string>,
) {
	const output = await run([
		'display-message',
		'-p',
		'-t',
		pane,
		'#{pane_width} #{pane_height}',
	]);
	const [cols, rows] = output.trim().split(' ').map(Number);
	return {cols, rows};
}

test('zoom reconciliation waits for geometry without blocking other work or toggling an already zoomed pane', async t => {
	let release = () => {};
	const pending = new Promise<void>(resolve => {
		release = resolve;
	});
	let zoomed = false;
	let finished = false;
	const mutations: string[][] = [];
	const run = async (args: string[]) => {
		await pending;
		if (args[0] === 'resize-pane') {
			zoomed = !zoomed;
			mutations.push(args);
		}
		return `%fixture ${zoomed ? 160 : 30} 50 160 50 ${Number(zoomed)} ${zoomed ? 159 : 29}`;
	};
	const layout = {
		listPaneId: '%fixture',
		agentViewerPaneId: '%agent',
		companionViewerPaneId: '',
	};
	const reconciling = reconcilePaneLayout(layout, true, run).then(result => {
		finished = true;
		return result;
	});
	await nextTurn();
	t.false(finished);
	t.false(zoomed);
	release();
	const result = await reconciling;
	t.deepEqual(result.dimensions, {cols: 160, rows: 50});
	await reconcilePaneLayout(layout, true, run);
	t.deepEqual(mutations, [['resize-pane', '-Z', '-t', '%fixture']]);
});

async function paneWidth(
	pane: string,
	run: (args: string[]) => Promise<string>,
) {
	const dimensions = await getPaneDimensions(pane, run);
	return dimensions.cols;
}

test.serial(
	'isolated tmux preserves rail and companion drags, focus and inner sessions across zoom and orientation changes',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-layout-'));
		const socket = path.join(dir, 'outer');
		const inner = path.join(dir, 'inner');
		const run = async (args: string[]) => {
			const {stdout} = await exec('tmux', ['-S', socket, ...args], {
				env: {...process.env, TMUX: ''},
				timeout: 5000,
			});
			return stdout;
		};
		const {registryFile} = testTmuxState(t);
		t.teardown(async () => {
			for (const target of [socket, inner]) {
				try {
					await exec('tmux', ['-S', target, 'kill-server']);
				} catch {}
			}
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
		const initial = await rebuildLayout(pane, '', '', run);
		t.truthy(initial);
		if (!initial) return;
		let {layout} = initial;
		t.true((await paneWidth(pane, run)) < 220);
		await run(['resize-pane', '-t', pane, '-x', '44']);
		await reconcilePaneLayout(layout, false, run);
		t.is(await paneWidth(pane, run), 44);
		// A companion drag raises no resize in the list pane, so it is only seen
		// by the next relayout from some other cause, which must keep it.
		await run(['resize-pane', '-t', layout.companionViewerPaneId, '-x', '60']);
		await reconcilePaneLayout(layout, false, run);
		await reconcilePaneLayout(layout, false, run);
		t.is(await paneWidth(layout.companionViewerPaneId, run), 60);
		t.is(await paneWidth(pane, run), 44);
		const createdWindow = await run([
			'new-window',
			'-d',
			'-n',
			'other',
			'-P',
			'-F',
			'#{window_id}',
		]);
		const otherWindow = createdWindow.trim();
		await run(['resize-window', '-t', otherWindow, '-x', '400', '-y', '60']);
		await run(['select-window', '-t', otherWindow]);
		const reconciled: string[][] = [];
		t.truthy(
			await reconcilePaneLayout(layout, false, async args => {
				reconciled.push(args);
				return run(args);
			}),
		);
		t.is(await paneWidth(pane, run), 44);
		t.is(await paneWidth(layout.companionViewerPaneId, run), 60);
		t.false(reconciled.some(args => args[0] === 'resize-pane'));
		t.is(reconciled.filter(args => args[0] === 'list-panes').length, 1);
		const zoomed = await reconcilePaneLayout(layout, true, run);
		t.deepEqual(zoomed.dimensions, {cols: 220, rows: 50});
		const restored = await reconcilePaneLayout(zoomed.layout, false, run);
		t.deepEqual(restored.dimensions, {cols: 44, rows: 50});
		t.is(await paneWidth(layout.companionViewerPaneId, run), 60);
		await run(['select-window', '-t', pane]);

		await reconcilePaneLayout(layout, true, run);
		t.deepEqual(await getPaneDimensions(pane, run), {cols: 220, rows: 50});
		await reconcilePaneLayout(layout, true, run);
		t.is(await paneWidth(pane, run), 220);
		await reconcilePaneLayout(layout, false, run);
		t.is(await paneWidth(pane, run), 44);
		await exec('tmux', [
			'-S',
			inner,
			'-f',
			'/dev/null',
			'new-session',
			'-d',
			'-s',
			'work',
			'sleep 60',
		]);
		const {stdout: originalSession} = await exec('tmux', [
			'-S',
			inner,
			'list-sessions',
			'-F',
			'#{session_id}:#{session_created}',
		]);
		await run([
			'respawn-pane',
			'-k',
			'-t',
			layout.agentViewerPaneId,
			`env -u TMUX tmux -S '${inner}' attach-session -t work`,
		]);
		await run(['resize-window', '-x', '80', '-y', '40']);
		({layout} = await reconcilePaneLayout(layout, false, run));
		t.truthy(layout);
		if (!layout) return;
		t.is(layout.companionViewerPaneId, '');
		t.is(await paneWidth(pane, run), 80);
		fs.writeFileSync(
			registryFile,
			JSON.stringify(Array.from({length: 8}, (_, i) => `TEST-${i}`)),
		);
		await reconcilePaneLayout(layout, false, run);
		const narrowDimensions = await getPaneDimensions(pane, run);
		t.is(narrowDimensions.rows, 9);
		const activePane = await run(['display-message', '-p', '#{pane_id}']);
		t.is(activePane.trim(), pane);
		await run(['resize-window', '-x', '220', '-y', '50']);
		const wide = await rebuildLayout(pane, layout.agentViewerPaneId, '', run);
		t.truthy(wide);
		if (!wide) return;
		layout = wide.layout;
		t.truthy(layout.companionViewerPaneId);
		t.is(await paneWidth(pane, run), 44);
		t.is(await paneWidth(layout!.companionViewerPaneId, run), 60);
		const {stdout: survivingSession} = await exec('tmux', [
			'-S',
			inner,
			'list-sessions',
			'-F',
			'#{session_id}:#{session_created}',
		]);
		t.is(survivingSession, originalSession);
	},
);

test.serial(
	'a layout pass still sizes the rail after the companion pane has closed',
	async t => {
		try {
			await exec('tmux', ['-V']);
		} catch {
			t.pass('tmux unavailable');
			return;
		}

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-layout-'));
		const socket = path.join(dir, 'outer');
		const run = async (args: string[]) => {
			const {stdout} = await exec('tmux', ['-S', socket, ...args], {
				env: {...process.env, TMUX: ''},
				timeout: 5000,
			});
			return stdout;
		};

		testTmuxState(t);
		t.teardown(async () => {
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
		const initial = await rebuildLayout(pane, '', '', run);
		t.truthy(initial);
		if (!initial) return;
		const railWidth = await paneWidth(pane, run);

		await run(['kill-pane', '-t', initial.layout.companionViewerPaneId]);
		await run(['resize-pane', '-t', pane, '-x', String(railWidth + 20)]);
		await reconcilePaneLayout(initial.layout, false, run);
		await reconcilePaneLayout(initial.layout, false, run);
		t.is(await paneWidth(pane, run), railWidth + 20);
	},
);

test('failed geometry discovery leaves existing panes untouched', async t => {
	const commands: string[] = [];
	const result = await rebuildLayout(
		'%list',
		'%claude',
		'%companion',
		async args => {
			commands.push(args[0]!);
			throw new Error('fixture tmux unavailable');
		},
	);
	t.is(result, null);
	t.deepEqual(commands, ['list-panes']);
});
