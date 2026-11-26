import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkspaceStatuses} from '../source/workspace-status.ts';
import {
	LIVENESS_CHECK_MS,
	STATUS_MONITOR_OPTION,
	STATUS_PANE_FORMAT,
	listStatusPanes,
	parseStatusPane,
	programStatusPath,
	runStatusTmux,
	shellQuoteStatus,
} from '../source/program-status-monitor.ts';
import {
	StatusHarness,
	projectRoot,
	untilSeen,
} from './program-status-harness.ts';

const harness = new StatusHarness();
const previousPath = process.env['PATH'];
const realTmux = execFileSync('which', ['tmux'], {encoding: 'utf8'}).trim();
const bin = path.join(harness.root, 'bin');
mkdirSync(bin);
const calls = path.join(harness.root, 'tmux-calls');
const shim = `#!/bin/bash
printf '%s\\n' "$*" >> ${shellQuoteStatus(calls)}
exec ${shellQuoteStatus(realTmux)} "$@"
`;
execFileSync('shellcheck', ['-s', 'bash', '-'], {input: shim});
writeFileSync(path.join(bin, 'tmux'), shim, {mode: 0o755});
process.env['PATH'] = `${bin}:${previousPath}`;
const repo = 'lifecycle';
const programStatus = harness.programStatus(repo);
const key = 'fixture';
const session = 'lifecycle-fixture';
let publisher: ChildProcess | undefined;
let stopWatch: (() => void) | undefined;
const evidence: Record<string, unknown> = {};

try {
	await harness.tmux([
		'new-session',
		'-d',
		'-s',
		session,
		'/bin/bash',
		'--noprofile',
		'--norc',
	]);
	const pane = await programStatus.attach(key, session);
	assert.ok(pane);
	await harness.fixture(session);
	await harness.emit(session, 'state=working:app=fixture');
	let queries = 0;
	const statuses = new WorkspaceStatuses(
		programStatus,
		() => session,
		harness.claudeStatus,
		async args => {
			queries++;
			return runStatusTmux(args);
		},
	);
	const initial = await untilSeen(
		async () => statuses.read(key),
		info => info?.status === 'working',
		'initial status',
	);
	const originalWindow = await harness.tmux([
		'display-message',
		'-p',
		'-t',
		pane.id,
		'#{window_id}',
	]);
	await harness.tmux([
		'new-window',
		'-t',
		`=${session}:`,
		'/bin/bash',
		'--noprofile',
		'--norc',
	]);
	const afterWindow = await statuses.read(key);
	assert.equal(afterWindow?.generation, initial?.generation);
	await harness.tmux(['select-window', '-t', originalWindow.trim()]);
	const split = await harness.tmux([
		'split-window',
		'-b',
		'-h',
		'-P',
		'-F',
		'#{pane_id}',
		'-t',
		pane.id,
		'/bin/bash',
		'--noprofile',
		'--norc',
	]);
	const afterSplit = await statuses.read(key);
	assert.equal(afterSplit?.generation, initial?.generation);
	const splitPipe = await harness.tmux([
		'display-message',
		'-p',
		'-t',
		split.trim(),
		'#{pane_pipe}',
	]);
	assert.equal(splitPipe.trim(), '0');
	await harness.tmux(['select-pane', '-t', pane.id]);
	evidence['pane-selection'] =
		'new windows and inserted splits preserve the agent generation; unrelated panes remain unpiped';
	console.log('PASS window and split selection preserve agent ownership');

	const probe = 'lifecycle-probe';
	const shell = ['/bin/bash', '--noprofile', '--norc'];
	await harness.tmux(['new-session', '-d', '-s', probe, ...shell]);
	const middle = await harness
		.tmux([
			'new-window',
			'-P',
			'-F',
			'#{window_id}',
			'-t',
			`=${probe}:`,
			...shell,
		])
		.then(output => output.trim());
	await harness.tmux(['split-window', '-h', '-t', middle, ...shell]);
	await harness.tmux(['new-window', '-t', `=${probe}:`, ...shell]);
	await harness.tmux(['select-window', '-t', middle]);
	await harness.tmux(['select-pane', '-t', `${middle}.0`]);
	const current = await harness
		.tmux(['display-message', '-p', '-t', `=${probe}:`, '#{pane_id}'])
		.then(output => output.trim());
	const panes = await listStatusPanes(harness.socket);
	const located = panes.get(probe);
	assert.equal(located?.pane?.id, current);
	assert.equal(located?.pinned, '');
	evidence['current-pane'] =
		'an unpinned session locates the same pane as display-message -t =session:';
	console.log('PASS listing locates the current pane of an unpinned session');
	await harness.tmux(['kill-pane', '-t', current]);
	assert.equal(
		await programStatus.monitor('probe', probe, located, harness.socket),
		null,
	);
	const pin = await harness.tmux([
		'show-options',
		'-qv',
		'-t',
		`=${probe}:`,
		'@pappardelle_status_pane',
	]);
	assert.equal(pin.trim(), '');
	await harness.tmux(['kill-session', '-t', `=${probe}`]);
	evidence['stale-listing'] =
		'a pane closed after the listing is neither piped nor pinned';
	console.log('PASS a pane closed after the listing is not pinned');

	const owned = 'lifecycle-owned';
	await harness.tmux(['new-session', '-d', '-s', owned, ...shell]);
	const listing = await listStatusPanes(harness.socket);
	const unpiped = listing.get(owned);
	assert.ok(unpiped?.pane);
	assert.equal(unpiped.pane.piped, false);
	const ownedPane = unpiped.pane.id;
	await harness.tmux(['pipe-pane', '-t', ownedPane, 'cat >/dev/null']);
	await harness.tmux([
		'set-option',
		'-p',
		'-t',
		ownedPane,
		STATUS_MONITOR_OPTION,
		'other-owner',
	]);
	await programStatus.monitor('owned', owned, unpiped, harness.socket);
	const afterAttach = parseStatusPane(
		await harness.tmux([
			'display-message',
			'-p',
			'-t',
			ownedPane,
			STATUS_PANE_FORMAT,
		]),
		harness.socket,
	);
	assert.equal(afterAttach?.piped, true);
	assert.equal(afterAttach?.marker, 'other-owner');
	await harness.tmux(['kill-session', '-t', `=${owned}`]);
	evidence['foreign-pipe'] =
		'a pane piped by another owner after the listing keeps its pipe and marker';
	console.log('PASS a pane piped after the listing keeps its owner');

	let delivered = 0;
	const deliveredCount = () => delivered;
	stopWatch = statuses.watch(
		() => {
			delivered++;
		},
		candidate => candidate === key,
	);
	await delay(0);
	const before = queries;
	for (let i = 0; i < 3; i++) {
		const target = delivered + 1;
		await harness.emit(session, `state=working:app=fixture:progress=${i + 1}`);
		await untilSeen(deliveredCount, count => count >= target, 'watcher event');
	}
	assert.equal(queries - before, 0);
	stopWatch();
	evidence['watcher-discovery-commands'] = queries - before;
	console.log('PASS native watcher updates avoid tmux discovery');

	const callsBefore = readFileSync(calls, 'utf8').length;
	await delay(LIVENESS_CHECK_MS + 1000);
	assert.equal(readFileSync(calls, 'utf8').slice(callsBefore), '');
	const afterInterval = await programStatus.read(key, pane);
	assert.equal(afterInterval?.exited, false);
	await harness.emit(session, 'state=blocked:app=fixture:kind=question');
	await untilSeen(
		async () => statuses.read(key),
		info => info?.status === 'blocked',
		'report after a liveness interval',
	);
	evidence['liveness-without-tmux'] =
		'a live monitor makes no tmux call across a liveness interval and keeps reporting';
	console.log(
		'PASS the liveness check makes no tmux call and keeps the monitor live',
	);

	const racePane = parseStatusPane(
		`${pane.id}\t${pane.pid}\t0\t1\t${randomUUID()}`,
		harness.socket,
	)!;
	const lease = `${programStatusPath(harness.statusDir(repo), 'race', racePane.generation)}.lease`;
	const ready = path.join(harness.root, 'publisher-ready');
	const script = path.join(harness.root, 'paused-publisher.mjs');
	writeFileSync(lease, '');
	writeFileSync(
		script,
		`
import fs from 'node:fs';
const {monitorPane} = await import(${JSON.stringify(path.join(projectRoot, 'source/program-status-monitor.ts'))});
const {daemonPublisher} = await import(${JSON.stringify(path.join(projectRoot, 'source/program-status-daemon.ts'))});
const publisher = daemonPublisher({dir: ${JSON.stringify(path.dirname(lease))}, socketPath: ${JSON.stringify(harness.statusSocket)}});
monitorPane(${JSON.stringify(repo)}, 'race', ${JSON.stringify(racePane)}, publisher);
fs.writeFileSync(${JSON.stringify(ready)}, '');
`,
	);
	publisher = spawn(process.execPath, [script], {
		stdio: ['pipe', 'ignore', 'inherit'],
	});
	await untilSeen(() => existsSync(ready), Boolean, 'publisher starts');
	publisher.stdin?.write(
		'\x1b]7501;state=idle:app=fixture:msg=cmVjb3JkZWQgbWVzc2FnZQ==\x07',
	);
	// What a revoked lease has to stop is the publisher's next send.
	await untilSeen(
		async () => harness.heldSnapshots(repo, 'race'),
		held => held === 1,
		'publisher sends its snapshot to the daemon',
	);
	await programStatus.remove('race');
	publisher.stdin?.write('\x1b]7501;state=working:app=fixture\x07');
	await delay(500);

	assert.equal(existsSync(lease), false);
	assert.equal(await harness.heldSnapshots(repo, 'race'), 0);
	evidence['late-publication'] =
		'revoked generation sends no snapshot to the daemon';
	console.log(
		'PASS revoked lease prevents an in-flight publisher recreating a snapshot',
	);

	await harness.tmux(['kill-pane', '-t', pane.id]);
	assert.equal(await programStatus.attach(key, session), null);
	evidence['missing-pin'] = 'surviving windows are not rebound as agent panes';
	console.log('PASS missing pinned pane does not rebind another window');
	await untilSeen(
		() => publisher!.exitCode !== null || publisher!.signalCode !== null,
		Boolean,
		'owner death retires a monitor whose stdin never receives EOF',
	);
	evidence['owner-death-without-eof'] =
		'missing pane process retires the held-stdin publisher';
	console.log('PASS pane process death retires a monitor without pipe EOF');
	writeFileSync(
		path.join(harness.root, 'lifecycle-verification.json'),
		JSON.stringify(evidence, null, 2),
	);
	console.log(
		`Lifecycle evidence ${harness.root}/lifecycle-verification.json (--keep preserves it)`,
	);
} finally {
	stopWatch?.();
	if (
		publisher &&
		publisher.exitCode === null &&
		publisher.signalCode === null
	) {
		publisher.kill('SIGKILL');
		await once(publisher, 'exit');
	}
	await harness.cleanup(repo, key);
	process.env['PATH'] = previousPath;
}
