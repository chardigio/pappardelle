import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {WorkspaceStatuses} from '../source/workspace-status.ts';
import {
	parseStatusPane,
	programStatusPath,
	runStatusTmux,
	shellQuoteStatus,
} from '../source/program-status-monitor.ts';
import {StatusHarness, projectRoot, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const previousPath = process.env['PATH'];
const realTmux = execFileSync('which', ['tmux'], {encoding: 'utf8'}).trim();
const bin = path.join(harness.root, 'bin');
mkdirSync(bin);
const fail = path.join(harness.root, 'fail-probe');
const used = path.join(harness.root, 'probe-failed');
const shim = `#!/bin/bash
set -e
if [[ "$*" == *'#{pane_pid} #{pane_dead}'* && -f ${shellQuoteStatus(fail)} ]]; then
  rm ${shellQuoteStatus(fail)}
  touch ${shellQuoteStatus(used)}
  exit 1
fi
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
		'-f',
		'/dev/null',
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
	const initial = await until(
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
		await until(deliveredCount, count => count >= target, 'watcher event');
	}
	assert.equal(queries - before, 0);
	stopWatch();
	evidence['watcher-discovery-commands'] = queries - before;
	console.log('PASS native watcher updates avoid tmux discovery');

	writeFileSync(fail, '');
	await until(() => existsSync(used), Boolean, 'failed liveness probe');
	await delay(100);
	const afterFailedProbe = await programStatus.read(key, pane);
	assert.equal(afterFailedProbe?.exited, false);
	const afterProbe = await statuses.read(key);
	assert.equal(afterProbe?.status, 'working');
	await harness.emit(session, 'state=blocked:app=fixture:kind=question');
	await until(
		async () => statuses.read(key),
		info => info?.status === 'blocked',
		'report after failed probe',
	);
	evidence['failed-probe'] =
		'working and generation retained; subsequent blocked report consumed';
	console.log(
		'PASS failed liveness probe retains live state and subsequent reports',
	);

	const racePane = parseStatusPane(
		`${pane.id}\t${pane.pid}\t0\t1\t${randomUUID()}`,
		harness.socket,
	)!;
	const target = programStatusPath(
		harness.statusDir(repo),
		'race',
		racePane.generation,
	);
	const ready = path.join(harness.root, 'publisher-ready');
	const paused = path.join(harness.root, 'publisher-paused');
	const resume = path.join(harness.root, 'publisher-resume');
	const done = path.join(harness.root, 'publisher-done');
	const script = path.join(harness.root, 'paused-publisher.mjs');
	writeFileSync(target, '{}');
	writeFileSync(`${target}.lease`, '');
	writeFileSync(
		script,
		`
import fs from 'node:fs';
import {mock} from 'bun:test';
const original = fs.writeFileSync;
let intercepted = false;
const interceptedWrite = function(file, ...args) {
  if (!intercepted && String(file).startsWith(${JSON.stringify(`${target}.tmp.`)})) {
    intercepted = true;
    original(${JSON.stringify(paused)}, '');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(${JSON.stringify(resume)})) {
      if (Date.now() > deadline) throw new Error('Publisher was not resumed');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    setImmediate(() => original(${JSON.stringify(done)}, ''));
  }
  return original(file, ...args);
};
mock.module('node:fs', () => ({...fs, writeFileSync: interceptedWrite}));
const {monitorPane} = await import(${JSON.stringify(path.join(projectRoot, 'source/program-status-monitor.ts'))});
const {followedPublisher} = await import(${JSON.stringify(path.join(projectRoot, 'source/program-status-daemon.ts'))});
const publisher = followedPublisher({dir: ${JSON.stringify(path.dirname(target))}, socketPath: ${JSON.stringify(harness.statusSocket)}, daemonMode: () => ${JSON.stringify(harness.sqlite)}});
monitorPane(${JSON.stringify(repo)}, 'race', ${JSON.stringify(harness.socket)}, ${JSON.stringify(racePane)}, ${JSON.stringify(path.dirname(target))}, publisher);
original(${JSON.stringify(ready)}, '');
`,
	);
	publisher = spawn(process.execPath, [script], {
		stdio: ['pipe', 'ignore', 'inherit'],
	});
	await until(() => existsSync(ready), Boolean, 'publisher starts');
	publisher.stdin?.write(
		'\x1b]7501;state=idle:app=fixture:msg=cmVjb3JkZWQgbWVzc2FnZQ==\x07',
	);
	if (harness.sqlite) {
		// With the flag on the publisher writes no file to pause in. What a
		// revoked lease has to stop is its next send.
		await until(
			async () => harness.heldSnapshots(repo, 'race'),
			held => held === 1,
			'publisher sends its snapshot to the daemon',
		);
		await until(
			() => existsSync(target),
			retained => !retained,
			'publisher removes the snapshot file it found',
		);
		await programStatus.remove('race');
		publisher.stdin?.write('\x1b]7501;state=working:app=fixture\x07');
		await delay(500);
	} else {
		await until(
			() => existsSync(paused),
			Boolean,
			'publication pauses after initial lease check',
		);
		await programStatus.remove('race');
		writeFileSync(resume, '');
		await until(() => existsSync(done), Boolean, 'publication resumes');
	}

	assert.equal(existsSync(target), false);
	assert.equal(existsSync(`${target}.lease`), false);
	assert.equal(await harness.heldSnapshots(repo, 'race'), 0);
	evidence['late-publication'] = harness.sqlite
		? 'revoked generation sends no snapshot to the daemon'
		: 'revoked generation cannot recreate its snapshot after rename';
	console.log(
		'PASS revoked lease prevents an in-flight publisher recreating a snapshot',
	);

	await harness.tmux(['kill-pane', '-t', pane.id]);
	assert.equal(await programStatus.attach(key, session), null);
	evidence['missing-pin'] = 'surviving windows are not rebound as agent panes';
	console.log('PASS missing pinned pane does not rebind another window');
	await until(
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
