import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	getPaneDimensions,
	getLayoutDirections,
	setPaneZoom,
	rebuildLayout,
	relayoutPanes,
} from './tmux.ts';
import {setRegistryPath, resetRegistryPath} from './space-registry.ts';

const exec = promisify(execFile);

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
		setRegistryPath(path.join(dir, 'registry.json'));
		t.teardown(async () => {
			for (const target of [socket, inner]) {
				try {
					await exec('tmux', ['-S', target, 'kill-server']);
				} catch {}
			}
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
			'220',
			'-y',
			'50',
		]);
		await run(['set-option', '-g', 'status', 'off']);
		const paneOutput = await run(['display-message', '-p', '#{pane_id}']);
		const pane = paneOutput.trim();
		let layout = await rebuildLayout(pane, '', '', run);
		t.truthy(layout);
		if (!layout) return;
		t.deepEqual(await getLayoutDirections(pane, run), {
			current: 'horizontal',
			desired: 'horizontal',
		});
		await run(['resize-pane', '-t', pane, '-x', '44']);
		t.true(await relayoutPanes(pane, layout.companionViewerPaneId, run));
		t.is(await paneWidth(pane, run), 44);
		// A companion drag raises no resize in the list pane, so it is only seen
		// by the next relayout from some other cause, which must keep it.
		await run(['resize-pane', '-t', layout.companionViewerPaneId, '-x', '60']);
		t.true(await relayoutPanes(pane, layout.companionViewerPaneId, run));
		t.true(await relayoutPanes(pane, layout.companionViewerPaneId, run));
		t.is(await paneWidth(layout.companionViewerPaneId, run), 60);
		t.is(await paneWidth(pane, run), 44);
		const before: number[] = [];
		const after: number[] = [];
		for (let i = 0; i < 3; i++) {
			const start = performance.now();
			execFileSync('tmux', [
				'-S',
				socket,
				'display-message',
				'-p',
				'-t',
				pane,
				'#{window_zoomed_flag}',
			]);
			execFileSync('tmux', ['-S', socket, 'resize-pane', '-Z', '-t', pane]);
			await delay(100);
			before.push(performance.now() - start);
			await setPaneZoom(pane, false, run);
			const next = performance.now();
			await setPaneZoom(pane, true, run);
			await getPaneDimensions(pane, run);
			after.push(performance.now() - next);
			await setPaneZoom(pane, false, run);
		}
		const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
		t.log(
			`isolated tmux zoom readiness: ${median(before).toFixed(1)} ms with old 100ms wait, ${median(after).toFixed(1)} ms with confirmed geometry`,
		);
		await setPaneZoom(pane, true, run);
		t.deepEqual(await getPaneDimensions(pane, run), {cols: 220, rows: 50});
		await setPaneZoom(pane, true, run);
		t.is(await paneWidth(pane, run), 220);
		await setPaneZoom(pane, false, run);
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
			layout.claudeViewerPaneId,
			`env -u TMUX tmux -S '${inner}' attach-session -t work`,
		]);
		await run(['resize-window', '-x', '80', '-y', '40']);
		layout = await rebuildLayout(
			pane,
			layout.claudeViewerPaneId,
			layout.companionViewerPaneId,
			run,
		);
		t.truthy(layout);
		if (!layout) return;
		t.is(layout.companionViewerPaneId, '');
		t.deepEqual(await getLayoutDirections(pane, run), {
			current: 'vertical',
			desired: 'vertical',
		});
		const activePane = await run(['display-message', '-p', '#{pane_id}']);
		t.is(activePane.trim(), pane);
		await run(['resize-window', '-x', '220', '-y', '50']);
		layout = await rebuildLayout(pane, layout.claudeViewerPaneId, '', run);
		t.truthy(layout?.companionViewerPaneId);
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

test('slow tmux responses leave timers responsive and zoom has no fixed settling delay', async t => {
	let zoomed = false;
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 2);
	t.teardown(() => clearInterval(timer));
	const calls: string[][] = [];
	const run = async (args: string[]) => {
		calls.push(args);
		await delay(35);
		if (args[0] === 'resize-pane') zoomed = !zoomed;
		return zoomed ? '1' : '0';
	};
	await setPaneZoom('%fixture', true, run);
	t.true(ticks >= 10);
	t.is(calls.length, 2);
	t.true(zoomed);
	await setPaneZoom('%fixture', true, run);
	t.is(calls.length, 3);
	t.true(zoomed);
});

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
	t.deepEqual(commands, ['display-message']);
});
