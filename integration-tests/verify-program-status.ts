import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {getRepoName} from '../source/config.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {
	ensureAgentSession,
	getSessionNames,
	initTmuxState,
} from '../source/tmux.ts';
import {shellQuoteStatus} from '../source/program-status-monitor.ts';
import {StatusHarness, projectRoot, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const repo = getRepoName();
const key = 'STATUS-TS';
const session = getSessionNames(key, repo).agent;
const launchMarker = path.join(harness.root, 'launch-marker');
// The launch names the space's agent-sessions file, which the stores place.
initTmuxState(
	createStateDaos({
		repo,
		stateDir: harness.stateDir,
		sqlite: process.env['PAPPARDELLE_SQLITE_STATE'] === '1',
	}),
);

try {
	const launched = await ensureAgentSession(
		key,
		harness.root,
		false,
		async args => {
			const fixtureArgs = args.slice(2);
			if (fixtureArgs.includes('new-session')) {
				fixtureArgs[fixtureArgs.indexOf(';') - 1] =
					`printf '%s' launched > ${shellQuoteStatus(launchMarker)}`;
			}
			return harness.tmux(fixtureArgs);
		},
	);
	assert.ok(launched);
	await until(
		() => {
			try {
				return readFileSync(launchMarker, 'utf8') === 'launched';
			} catch {
				return false;
			}
		},
		value => value,
		'TypeScript launch executes command in the ordinary shell',
	);
	await harness.tmux([
		'set-option',
		'-p',
		'-t',
		`=${session}:`,
		'remain-on-exit',
		'on',
	]);
	await harness.mount(repo, key, session);
	await harness.writeHook(key, 'waiting_for_input');
	await harness.expect(
		'idle',
		'TypeScript launch: hook fallback',
		{source: 'hook'},
		'●',
	);
	await harness.fixture(session);
	await harness.expect(
		'idle',
		'read-only monitor preserves queries and captures native idle',
		{source: 'osc', app: 'fixture'},
		'●',
	);
	await harness.emit(
		session,
		'state=working:app=fixture:progress=25:msg=aGVsbG8=',
		'bel',
	);
	await harness.expect('working', 'BEL report stores message and progress', {
		message: 'hello',
		progress: 25,
	});
	await harness.emit(session, 'state=blocked:id=child:kind=question');
	await harness.expect(
		'blocked',
		'blocked child inherits app and renders question',
		{id: 'child', kind: 'question', app: 'fixture'},
		'?',
	);
	await harness.writeHook(key, 'error');
	await delay(150);
	await harness.expect(
		'blocked',
		'conflicting hook cannot replace native child',
		{kind: 'question'},
		'?',
	);
	harness.unmount();
	await harness.mount(repo, key, session);
	await harness.expect(
		'blocked',
		'TUI restart retains live monitor and records',
		{source: 'osc', kind: 'question'},
		'?',
	);
	await harness.emit(session, 'state=clear:id=child');
	await harness.expect('working', 'subtree clear restores root');
	await harness.emit(session, 'state=blocked:app=fixture:kind=auth');
	await harness.expect(
		'blocked',
		'authentication renders attention indicator',
		{kind: 'auth'},
		'!',
	);
	await harness.emit(session, 'state=error:app=fixture');
	await harness.expect('error', 'error renders red error indicator', {}, '✗');
	await harness.raw(session, Buffer.from('\x1b[!p\x1b[?1049h\x1b[?1049l'));
	await delay(100);
	await harness.expect(
		'error',
		'DECSTR and alternate screen retain status',
		{},
		'✗',
	);
	await harness.emit(session, 'state=done:app=fixture');
	await harness.expect('done', 'completion renders green indicator', {}, '●');
	await harness.emit(session, 'state=working:id=child');
	await harness.expect('working', 'child work overrides completed root', {
		id: 'child',
	});
	await harness.raw(session, Buffer.from('\x1b]133;A\x07'));
	await harness.expect(
		'done',
		'shell prompt drops active children and retains completion',
		{},
		'●',
	);
	await harness.tmux([
		'resize-window',
		'-t',
		`=${session}:`,
		'-x',
		'91',
		'-y',
		'33',
	]);
	const sizeFile = path.join(harness.root, 'size.json');
	await delay(100);
	await harness.type(session, JSON.stringify({size: sizeFile}));
	await until(
		() => {
			try {
				return JSON.parse(readFileSync(sizeFile, 'utf8')) as {
					columns: number;
					rows: number;
				};
			} catch {
				return null;
			}
		},
		size => size?.columns === 91 && size.rows === 33,
		'PTY resize',
	);
	harness.checks.push({
		label: 'normal keyboard input and terminal resizing preserved',
	});
	await harness.emit(session, 'state=clear');
	await harness.expect(
		'unknown',
		'clear remains authoritative',
		{source: 'osc'},
		'?',
	);
	await harness.emit(session, 'state=working:app=fixture');
	await harness.expect('working', 'working before pane exit');
	await harness.tmux(['send-keys', '-t', `=${session}:`, 'C-d']);
	await harness.tmux(['kill-pane', '-t', `=${session}:`]);
	await harness.tmux([
		'new-session',
		'-d',
		'-s',
		session,
		'-c',
		harness.root,
		'/bin/bash',
		'-l',
	]);
	await harness.mount(repo, key, session);
	await harness.expect(
		'error',
		'replacement pane rejects previous generation',
		{source: 'hook'},
		'✗',
	);
	await Promise.all(
		Array.from({length: 8}, async () =>
			harness.programStatus(repo).attach(key, session),
		),
	);
	await harness.fixture(session);
	await harness.expect(
		'idle',
		'concurrent attachment keeps marker and pipe consistent',
		{source: 'osc'},
		'●',
	);
	const shellKey = 'STATUS-SHELL';
	const shellRepo = 'second-repo';
	const shellSession = getSessionNames(shellKey, shellRepo).agent;
	execFileSync(
		'bash',
		[
			path.join(projectRoot, 'scripts/start-agent-session.sh'),
			'--issue-key',
			shellKey,
			'--repo-name',
			shellRepo,
			'--worktree',
			harness.root,
			'--no-agent',
		],
		{env: process.env, timeout: 10000},
	);
	await harness.mount(shellRepo, shellKey, shellSession);
	await harness.fixture(shellSession);
	await harness.emit(shellSession, 'state=blocked:kind=permission:app=fixture');
	await harness.expect(
		'blocked',
		'shell launch and concurrent repository are isolated',
		{kind: 'permission'},
		'!',
	);
	await harness.programStatus(shellRepo).remove(shellKey);
	await harness.tmux(['kill-session', '-t', `=${shellSession}`]);
	await delay(500);
	assert.equal(
		readdirSync(harness.statusDir(shellRepo)).length,
		0,
		'late monitor exit must not recreate deleted snapshots',
	);
	assert.equal(
		harness.snapshotRows(shellRepo, shellKey),
		0,
		'late monitor exit must not recreate deleted rows',
	);
	harness.checks.push({
		label: 'workspace removal prevents late snapshot recreation',
	});
	const unrelated = 'unrelated-pipe';
	await harness.tmux(['new-session', '-d', '-s', unrelated]);
	await harness.tmux([
		'pipe-pane',
		'-O',
		'-t',
		`=${unrelated}:`,
		`cat > ${shellQuoteStatus(path.join(harness.root, 'unrelated.log'))}`,
	]);
	const pane = await harness.programStatus('other').attach('other', unrelated);
	assert.equal(pane?.marker, '');
	harness.checks.push({
		label: 'unrelated pipe remains owned by its original command',
	});
	writeFileSync(
		path.join(harness.root, 'verification.json'),
		JSON.stringify({checks: harness.checks}, null, 2),
	);
	console.log(
		`Passed ${harness.checks.length} checks; evidence ${harness.root}/verification.json (--keep preserves it)`,
	);
} finally {
	await harness.cleanup(repo, key);
}
