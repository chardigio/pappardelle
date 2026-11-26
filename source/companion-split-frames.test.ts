// Companion splits shown as framed outer panes, on isolated tmux servers.
// Both servers run on sockets in a temp directory and are killed through
// those sockets only.
import {tmpdir} from 'node:os';
import {execFile, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {sessionNamesFor} from './space-identity.ts';
import {test, expect, afterAll} from 'bun:test';
import {LatestTask} from './latest-task.ts';
import {testTmuxState} from '../test/helpers/state.ts';
import {REAL_TMUX_TIMEOUT_MS, until} from '../test/helpers/wait.ts';
import {getRepoName} from './config.ts';
import {
	companionSplitPaneIds,
	createCompanionSplit,
	storedIdentity,
	measureCompanionColumnWidth,
	rebuildLayout,
	reconcilePaneLayout,
	setConfiguredPaneWidthsForTests,
	syncCompanionSplits,
	takePendingSplitSync,
} from './tmux.ts';

const exec = promisify(execFile);
const tmuxTest = spawnSync('tmux', ['-V']).status === 0 ? test : test.skip;

const dir = fs.realpathSync(fs.mkdtempSync(`${tmpdir()}/pcs-`));
const outer = `${dir}/o`;
const inner = `${dir}/i`;
const env = {...process.env, SHELL: '/bin/sh', PAPPARDELLE_TMUX_SOCKET: inner};
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
	const {companion} = sessionNamesFor(key, getRepoName());
	await innerTmux('new-session', '-d', '-s', companion, '-c', dir, 'sleep 600');
	for (const split of splits) {
		const created = createCompanionSplit(storedIdentity(key)!, {
			...split,
			command: 'sleep 600',
		});
		if (!created.ok) throw new Error(created.reason);
		// Creation order is by the millisecond.
		await delay(5);
	}
}

const option = async (session: string, name: string) =>
	innerTmux('show-options', '-qv', '-t', `=${session}:`, name);

afterAll(() => {
	for (const socket of [outer, inner])
		spawnSync('tmux', ['-S', socket, 'kill-server'], {env});
	fs.rmSync(dir, {recursive: true, force: true});
});

tmuxTest(
	'splits show in framed panes of their own, move between spaces and keep a dragged size',
	async () => {
		// Without the database a space's sessions get the names idow gives them.
		testTmuxState({repo: getRepoName(), sqlite: false});
		// The repo that holds this test can set companion_width in its own
		// .pappardelle.yml (the monorepo sets 20). A pane that narrow cuts the
		// split titles, so the test uses the built-in widths.
		setConfiguredPaneWidthsForTests({});
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
			expect.unreachable('no companion pane');
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
			`${sessionNamesFor(key, getRepoName()).companion}~${name}`;

		expect(await syncCompanionSplits(layout, a, {run})).toBe('applied');
		const splitPanes = companionSplitPaneIds();
		expect(splitPanes.length).toBe(2);
		expect(await paneCount()).toBe(5);
		await until(
			async () => {
				const screens = await Promise.all(
					splitPanes.map(async id => run(['capture-pane', '-p', '-t', id])),
				);
				return (
					screens.every(screen => screen.includes('╭')) &&
					screens[0]!.includes('tests') &&
					screens[1]!.includes('logs')
				);
			},
			{
				what: 'each split pane to draw its own titled frame',
				timeoutMs: REAL_TMUX_TIMEOUT_MS,
			},
		);
		expect(await clientSessions()).toStrictEqual([
			session(a, 'logs'),
			session(a, 'tests'),
		]);
		const column = await measureCompanionColumnWidth(layout, run);
		expect(column).toBeTruthy();
		const tests = await paneSize(splitPanes[0]!);
		expect(tests.h, '30% of the column height').toBe(
			Math.floor((50 * 30) / 100),
		);

		// Same splits: the clients move, the panes stay.
		expect(await syncCompanionSplits(layout, b, {run})).toBe('applied');
		expect(companionSplitPaneIds()).toStrictEqual(splitPanes);
		expect(await clientSessions()).toStrictEqual([
			session(b, 'logs'),
			session(b, 'tests'),
		]);

		// A drag while B shows belongs to B's tests split.
		await run(['resize-pane', '-t', splitPanes[0]!, '-y', '8']);
		expect(await syncCompanionSplits(layout, c, {run})).toBe('applied');
		expect(await option(session(b, 'tests'), '@pappa_size')).toBe('8');
		expect(companionSplitPaneIds()).toStrictEqual([]);
		expect(await paneCount()).toBe(3);

		expect(await syncCompanionSplits(layout, b, {run})).toBe('applied');
		const reopened = companionSplitPaneIds();
		const dragged = await paneSize(reopened[0]!);
		expect(dragged.h).toBe(8);

		// A size set after a drag (companion resize) wins over the drag.
		await run(['resize-pane', '-t', reopened[0]!, '-y', '10']);
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'12',
		);
		expect(await syncCompanionSplits(layout, b, {run})).toBe('applied');
		expect(await option(session(b, 'tests'), '@pappa_size')).toBe('12');
		const resized = await paneSize(companionSplitPaneIds()[0]!);
		expect(resized.h).toBe(12);
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'8',
		);
		expect(await syncCompanionSplits(layout, b, {run})).toBe('applied');
		const reopened2 = companionSplitPaneIds();

		// The rail and the column keep their widths with a split beside main,
		// and neither writes a split size.
		await run(['resize-pane', '-t', pane, '-x', '44']);
		await reconcilePaneLayout(layout, false, run);
		const rail = await paneSize(pane);
		expect(rail.w).toBe(44);
		expect(await measureCompanionColumnWidth(layout, run)).toBe(column);
		expect(await option(session(b, 'logs'), '@pappa_size')).toBe('');
		expect(companionSplitPaneIds()).toStrictEqual(reopened2);

		// A size that a resize in place can reach keeps the panes and clients.
		await innerTmux(
			'set-option',
			'-t',
			`=${session(b, 'tests')}:`,
			'@pappa_size',
			'30%',
		);
		expect(await syncCompanionSplits(layout, b, {run})).toBe('applied');
		expect(companionSplitPaneIds()).toStrictEqual(reopened2);
		const grown = await paneSize(reopened2[0]!);
		expect(grown.h).toBe(15);
		await run(['resize-window', '-t', pane, '-y', '40']);
		await reconcilePaneLayout(layout, false, run);
		expect(companionSplitPaneIds()).toStrictEqual(reopened2);
		const shorter = await paneSize(reopened2[0]!);
		expect(shorter.h).toBe(12);
		await run(['resize-window', '-t', pane, '-y', '50']);
		await reconcilePaneLayout(layout, false, run);
		expect(companionSplitPaneIds()).toStrictEqual(reopened2);

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
		expect(await option(session(b, 'logs'), '@pappa_size')).toBe('');
		const wider = (await measureCompanionColumnWidth(layout, run))!;
		expect(wider).toBe(column! + 12);
		const logs = await paneSize(companionSplitPaneIds()[1]!);
		expect(logs.w).toBe(Math.floor((wider - 1) / 2));
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
		const logsClientPid = Number(
			await innerTmux(
				'list-clients',
				'-f',
				`#{==:#{client_tty},${logsTty}}`,
				'-F',
				'#{client_pid}',
			),
		);
		expect(logsClientPid).toBeGreaterThan(0);
		// tmux 3.6 to 3.8 crash the server when a client that is detaching gets a
		// resize (tmux issue 5723), and this pane's frame may still be forwarding a
		// resize to its client. A killed client never detaches.
		process.kill(logsClientPid, 'SIGKILL');
		// Until the server reads the closed connection, switch-client still finds it.
		await until(
			async () => {
				const ttys = await innerTmux('list-clients', '-F', '#{client_tty}');
				return !ttys.split('\n').includes(logsTty);
			},
			{
				what: 'the inner server to drop the killed client',
				timeoutMs: REAL_TMUX_TIMEOUT_MS,
			},
		);
		expect(await syncCompanionSplits(layout, a, {run})).toBe('applied');
		const rebuilt = companionSplitPaneIds();
		expect(rebuilt.length).toBe(2);
		expect(rebuilt.some(id => settled.includes(id))).toBe(false);
		const panes = await outerPanes();
		expect(panes.includes(layout.agentViewerPaneId)).toBe(true);
		expect(panes.includes(layout.companionViewerPaneId)).toBe(true);
		// Each frame publishes its tty just before its client attaches.
		const rebuiltClients = [session(a, 'logs'), session(a, 'tests')];
		let clients: string[] = [];
		await until(
			async () => {
				clients = await clientSessions();
				return clients.join(' ') === rebuiltClients.join(' ');
			},
			{frame: () => clients.join(' '), timeoutMs: REAL_TMUX_TIMEOUT_MS},
		);

		// An open dialog zooms the rail; splitting would unzoom it.
		expect(
			createCompanionSplit(storedIdentity(a)!, {
				name: 'dev',
				split: 'down',
				command: 'sleep 600',
			}).ok,
		).toBe(true);
		await run(['resize-pane', '-Z', '-t', pane]);
		expect(await syncCompanionSplits(layout, a, {run})).toBe('deferred');
		expect(await display(pane, '#{window_zoomed_flag}')).toBe('1');
		expect(companionSplitPaneIds()).toStrictEqual(rebuilt);
		await run(['resize-pane', '-Z', '-t', pane]);
		expect(takePendingSplitSync()).toBe(true);
		expect(takePendingSplitSync()).toBe(false);

		// Two syncs queued together still end with one set of panes.
		const queue = new LatestTask();
		await Promise.all([
			queue.exclusive(async () => syncCompanionSplits(layout, a, {run})),
			queue.exclusive(async () => syncCompanionSplits(layout, a, {run})),
		]);
		expect(companionSplitPaneIds().length).toBe(3);
		expect(await paneCount()).toBe(6);

		// A split whose session ends takes its frame with it.
		await innerTmux('kill-session', '-t', `=${session(a, 'dev')}:`);
		await until(async () => (await paneCount()) === 5, {
			what: "the dev split's frame to close",
			timeoutMs: REAL_TMUX_TIMEOUT_MS,
		});
		// Its rows went to a neighbour, which is no drag of that neighbour.
		expect(await syncCompanionSplits(layout, a, {run})).toBe('applied');
		expect(await option(session(a, 'tests'), '@pappa_size')).toBe('30%');
		expect(await option(session(a, 'logs'), '@pappa_size')).toBe('');

		// The companion pane closes when the shell left in it exits, and its
		// splits close with it.
		await run(['kill-pane', '-t', layout.companionViewerPaneId]);
		expect(await syncCompanionSplits(layout, a, {run})).toBe('no-pane');
		expect(companionSplitPaneIds()).toStrictEqual([]);
		expect(await paneCount()).toBe(2);
	},
);
