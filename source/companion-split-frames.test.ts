// Companion splits shown as framed outer panes, on isolated tmux servers.
// Both servers run on sockets in a temp directory and are killed through
// those sockets only.
import {execFile, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import test from 'ava';
import {LatestTask} from './latest-task.ts';
import {setRegistryPath, resetRegistryPath} from './space-registry.ts';
import {
	companionSplitPaneIds,
	createCompanionSplit,
	getSessionNames,
	measureCompanionColumnWidth,
	rebuildLayout,
	reconcilePaneLayout,
	syncCompanionSplits,
	takePendingSplitSync,
} from './tmux.ts';

const exec = promisify(execFile);
const tmuxTest =
	spawnSync('tmux', ['-V']).status === 0 ? test.serial : test.serial.skip;

const dir = fs.realpathSync(fs.mkdtempSync('/tmp/pcs-'));
const outer = `${dir}/o`;
const inner = `${dir}/i`;
const {TMUX: _tmux, TMUX_PANE: _pane, ...inherited} = process.env;
const env = {...inherited, SHELL: '/bin/sh', PAPPARDELLE_TMUX_SOCKET: inner};
Object.assign(process.env, {SHELL: '/bin/sh', PAPPARDELLE_TMUX_SOCKET: inner});

// Inner calls already carry `-S inner` from innerTmuxArgs, which wins over
// the leading `-S outer`.
const run = async (args: string[]) => {
	const {stdout} = await exec('tmux', ['-S', outer, ...args], {
		env,
		timeout: 10_000,
	});
	return stdout;
};

const out = async (...args: string[]) => {
	const stdout = await run(args);
	return stdout.trim();
};

const innerTmux = async (...args: string[]) => out('-S', inner, ...args);

const display = async (paneId: string, format: string) =>
	out('display-message', '-p', '-t', paneId, format);

async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return true;
		await delay(50);
	}

	return false;
}

async function outerPanes(): Promise<string[]> {
	const panes = await out('list-panes', '-a', '-F', '#{pane_id}');
	return panes.split('\n');
}

async function paneCount(): Promise<number> {
	const panes = await outerPanes();
	return panes.length;
}

async function paneSize(paneId: string): Promise<{w: number; h: number}> {
	const size = await display(paneId, '#{pane_width} #{pane_height}');
	const [w, h] = size.split(' ').map(Number);
	return {w: w!, h: h!};
}

/** Which split session each split pane's nested client is showing. */
async function clientSessions(): Promise<string[]> {
	const clients = await innerTmux(
		'list-clients',
		'-F',
		'#{client_tty} #{session_name}',
	);
	return clients
		.split('\n')
		.map(line => line.split(' ')[1]!)
		.filter(name => name.includes('~'))
		.sort();
}

async function startSpace(
	key: string,
	splits: Array<{name: string; split: 'right' | 'down'; size?: `${number}%`}>,
) {
	const {companion} = getSessionNames(key);
	await innerTmux('new-session', '-d', '-s', companion, '-c', dir, 'sleep 600');
	for (const split of splits) {
		const created = createCompanionSplit(key, {...split, command: 'sleep 600'});
		if (!created.ok) throw new Error(created.reason);
		// Creation order is by the millisecond.
		await delay(5);
	}
}

const option = async (session: string, name: string) =>
	innerTmux('show-options', '-qv', '-t', `=${session}:`, name);

test.after.always(() => {
	for (const socket of [outer, inner])
		spawnSync('tmux', ['-S', socket, 'kill-server'], {env});
	resetRegistryPath();
	fs.rmSync(dir, {recursive: true, force: true});
});

tmuxTest(
	'splits show in framed panes of their own, move between spaces and keep a dragged size',
	async t => {
		setRegistryPath(`${dir}/registry.json`);
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
		await innerTmux(
			'-f',
			'/dev/null',
			'start-server',
			';',
			'set',
			'-g',
			'exit-empty',
			'off',
		);
		const pane = await out('display-message', '-p', '#{pane_id}');
		const built = await rebuildLayout(pane, '', '', run);
		const layout = built?.layout;
		if (!layout?.companionViewerPaneId) {
			t.fail('no companion pane');
			return;
		}

		const [a, b, c] = ['KEY-A', 'KEY-B', 'KEY-C'];
		await startSpace(a, [
			{name: 'tests', split: 'down', size: '30%'},
			{name: 'logs', split: 'right'},
		]);
		await startSpace(b, [
			{name: 'tests', split: 'down', size: '30%'},
			{name: 'logs', split: 'right'},
		]);
		await startSpace(c, []);
		const session = (key: string, name: string) =>
			`${getSessionNames(key).companion}~${name}`;

		t.is(await syncCompanionSplits(layout, a, {run}), 'applied');
		const splitPanes = companionSplitPaneIds();
		t.is(splitPanes.length, 2);
		t.is(await paneCount(), 5);
		t.true(
			await waitFor(async () => {
				const screens = await Promise.all(
					splitPanes.map(async id => run(['capture-pane', '-p', '-t', id])),
				);
				return (
					screens.every(screen => screen.includes('╭')) &&
					screens[0]!.includes('tests') &&
					screens[1]!.includes('logs')
				);
			}),
			'each split pane draws its own titled frame',
		);
		t.deepEqual(await clientSessions(), [
			session(a, 'logs'),
			session(a, 'tests'),
		]);
		const column = await measureCompanionColumnWidth(layout, run);
		t.truthy(column);
		const tests = await paneSize(splitPanes[0]!);
		t.is(tests.h, Math.floor((50 * 30) / 100), '30% of the column height');

		// Same splits: the clients move, the panes stay.
		t.is(await syncCompanionSplits(layout, b, {run}), 'applied');
		t.deepEqual(companionSplitPaneIds(), splitPanes);
		t.deepEqual(await clientSessions(), [
			session(b, 'logs'),
			session(b, 'tests'),
		]);

		// A drag while B shows belongs to B's tests split.
		await run(['resize-pane', '-t', splitPanes[0]!, '-y', '8']);
		t.is(await syncCompanionSplits(layout, c, {run}), 'applied');
		t.is(await option(session(b, 'tests'), '@pappa_size'), '8');
		t.deepEqual(companionSplitPaneIds(), []);
		t.is(await paneCount(), 3);

		t.is(await syncCompanionSplits(layout, b, {run}), 'applied');
		const reopened = companionSplitPaneIds();
		const dragged = await paneSize(reopened[0]!);
		t.is(dragged.h, 8);

		// A size set after a drag (companion resize) wins over the drag.
		await run(['resize-pane', '-t', reopened[0]!, '-y', '10']);
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'12',
		);
		t.is(await syncCompanionSplits(layout, b, {run}), 'applied');
		t.is(await option(session(b, 'tests'), '@pappa_size'), '12');
		const resized = await paneSize(companionSplitPaneIds()[0]!);
		t.is(resized.h, 12);
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'8',
		);
		t.is(await syncCompanionSplits(layout, b, {run}), 'applied');
		const reopened2 = companionSplitPaneIds();

		// The rail and the column keep their widths with a split beside main,
		// and neither writes a split size.
		await run(['resize-pane', '-t', pane, '-x', '44']);
		await reconcilePaneLayout(layout, false, run);
		const rail = await paneSize(pane);
		t.is(rail.w, 44);
		t.is(await measureCompanionColumnWidth(layout, run), column);
		t.is(await option(session(b, 'logs'), '@pappa_size'), '');
		t.deepEqual(companionSplitPaneIds(), reopened2);

		// A size that a resize in place can reach keeps the panes and clients.
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'30%',
		);
		t.is(await syncCompanionSplits(layout, b, {run}), 'applied');
		t.deepEqual(companionSplitPaneIds(), reopened2);
		const grown = await paneSize(reopened2[0]!);
		t.is(grown.h, 15);
		await run(['resize-window', '-t', pane, '-y', '40']);
		await reconcilePaneLayout(layout, false, run);
		t.deepEqual(companionSplitPaneIds(), reopened2);
		const shorter = await paneSize(reopened2[0]!);
		t.is(shorter.h, 12);
		await run(['resize-window', '-t', pane, '-y', '50']);
		await reconcilePaneLayout(layout, false, run);
		t.deepEqual(companionSplitPaneIds(), reopened2);

		// Dragging the agent pane's border resizes the whole column: the right
		// split keeps no size of its own, and goes back to half of main.
		const agent = await paneSize(layout.agentViewerPaneId);
		await run([
			'resize-pane',
			'-t',
			layout.agentViewerPaneId,
			'-x',
			String(agent.w - 12),
		]);
		await reconcilePaneLayout(layout, false, run);
		t.is(await option(session(b, 'logs'), '@pappa_size'), '');
		const wider = (await measureCompanionColumnWidth(layout, run))!;
		t.is(wider, column! + 12);
		const logs = await paneSize(companionSplitPaneIds()[1]!);
		t.is(logs.w, Math.floor((wider - 1) / 2));
		await run([
			'resize-pane',
			'-t',
			layout.agentViewerPaneId,
			'-x',
			String(agent.w),
		]);
		await reconcilePaneLayout(layout, false, run);
		const settled = companionSplitPaneIds();

		// A split client that left forces new split panes only.
		const logsTty = await display(settled[1]!, '#{@pappardelle_client_tty}');
		await innerTmux('detach-client', '-t', logsTty);
		t.is(await syncCompanionSplits(layout, a, {run}), 'applied');
		const rebuilt = companionSplitPaneIds();
		t.is(rebuilt.length, 2);
		t.false(rebuilt.some(id => settled.includes(id)));
		const panes = await outerPanes();
		t.true(panes.includes(layout.agentViewerPaneId));
		t.true(panes.includes(layout.companionViewerPaneId));
		t.deepEqual(await clientSessions(), [
			session(a, 'logs'),
			session(a, 'tests'),
		]);

		// An open dialog zooms the rail; splitting would unzoom it.
		t.true(
			createCompanionSplit(a, {
				name: 'dev',
				split: 'down',
				command: 'sleep 600',
			}).ok,
		);
		await run(['resize-pane', '-Z', '-t', pane]);
		t.is(await syncCompanionSplits(layout, a, {run}), 'deferred');
		t.is(await display(pane, '#{window_zoomed_flag}'), '1');
		t.deepEqual(companionSplitPaneIds(), rebuilt);
		await run(['resize-pane', '-Z', '-t', pane]);
		t.true(takePendingSplitSync());
		t.false(takePendingSplitSync());

		// Two syncs queued together still end with one set of panes.
		const queue = new LatestTask();
		await Promise.all([
			queue.exclusive(async () => syncCompanionSplits(layout, a, {run})),
			queue.exclusive(async () => syncCompanionSplits(layout, a, {run})),
		]);
		t.is(companionSplitPaneIds().length, 3);
		t.is(await paneCount(), 6);

		// A split whose session ends takes its frame with it.
		await innerTmux('kill-session', '-t', `=${session(a, 'dev')}:`);
		t.true(await waitFor(async () => (await paneCount()) === 5));
		// Its rows went to a neighbour, which is no drag of that neighbour.
		t.is(await syncCompanionSplits(layout, a, {run}), 'applied');
		t.is(await option(session(a, 'tests'), '@pappa_size'), '30%');
		t.is(await option(session(a, 'logs'), '@pappa_size'), '');
	},
);
