// The supervision verbs on an attach partner agent, whose session runs on its
// own tmux server: they must read and type there, not in the inner server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {runSuperviseCommand, type SuperviseDeps} from './supervise-command.ts';
import type {OuterTmuxRunner} from './tmux.ts';

const fixtures = path.join(
	import.meta.dirname,
	'..',
	'test',
	'fixtures',
	'agent-screens',
);
const fixture = (name: string) =>
	fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8');

const permission = [
	'────────────────────',
	' Bash command',
	' Clean up',
	'╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
	' rm -rf /tmp/q-abc',
	'╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
	' Do you want to proceed?',
	' ❯ 1. Yes',
	'   2. No',
	' Esc to cancel · Tab to amend',
].join('\n');

/** A tmux server holding `sessions`, every one showing `screen`. */
function server(sessions: string[], screen: string) {
	const targets: string[] = [];
	const runner: OuterTmuxRunner = args => {
		if (args[0] === 'list-sessions')
			return {status: 0, stdout: sessions.join('\n') + '\n'};
		if (args[0] === 'capture-pane') {
			targets.push(args.at(-1)!);
			return {status: 0, stdout: screen};
		}

		return {status: 1, stdout: ''};
	};

	return {runner, targets};
}

function harness(
	t: ExecutionContext,
	options: {innerSessions?: string[]; running?: boolean} = {},
) {
	const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-status-'));
	const previous = process.env['PAPPARDELLE_STATUS_DIR'];
	process.env['PAPPARDELLE_STATUS_DIR'] = statusDir;
	t.teardown(() => {
		if (previous === undefined) delete process.env['PAPPARDELLE_STATUS_DIR'];
		else process.env['PAPPARDELLE_STATUS_DIR'] = previous;
		fs.rmSync(statusDir, {recursive: true, force: true});
	});
	const inner = server(options.innerSessions ?? [], fixture('claude-idle'));
	const bot = server(['trotbot'], permission);
	const out: string[] = [];
	const err: string[] = [];
	let clock = new Date(2026, 10, 9, 12, 0).getTime();
	const deps: SuperviseDeps = {
		repo: () => 'repo',
		resolveKey: raw => raw,
		hookKey: async key => `repo-${key}`,
		runner: inner.runner,
		serverRunner: () => ({status: 1, stdout: ''}),
		now: () => new Date(clock),
		async sleep(ms) {
			clock += ms;
		},
		async waitForStatusChange(ms) {
			clock += ms;
		},
		send: async () => 'sent',
		sendKeys: () => 'sent',
		typeText: () => 'sent',
		classify: async () => ({allow: true, reason: 'ok'}),
		policy: {scratchRoots: []},
		store: () => ({root: statusDir, repo: 'repo'}),
		timers: () => ({create() {}, remove() {}}),
		caller: 'main',
		readStdin: () => undefined,
		out: text => out.push(text),
		err: text => err.push(text),
		log() {},
		locate: key =>
			key === 'trotbot' ? {session: 'trotbot', runner: bot.runner} : undefined,
		externalAgentKeys: () => (options.running === false ? [] : ['trotbot']),
	};
	return {
		inner,
		bot,
		out,
		err,
		run: async (...argv: string[]) => runSuperviseCommand(argv, deps),
	};
}

test("state reads an attach partner's screen on its own server", async t => {
	const h = harness(t);
	t.is(await h.run('state', 'trotbot', '--json'), 0);
	t.like(JSON.parse(h.out[0]!), {key: 'trotbot', state: 'permission'});
	t.true(h.bot.targets.every(target => target === '=trotbot:'));
	t.deepEqual(h.inner.targets, []);
});

test('screen shows the partner session, not an inner one', async t => {
	const h = harness(t);
	t.is(await h.run('screen', 'trotbot'), 0);
	t.regex(h.out.join('\n'), /rm -rf \/tmp\/q-abc/);
	t.deepEqual(h.inner.targets, []);
});

test('watching every space includes the running attach partners', async t => {
	const h = harness(t, {innerSessions: ['agent-repo-STA-1']});
	t.is(
		await h.run('watch', '--until', 'blocked', '--timeout', '1', '--json'),
		0,
	);
	const result = JSON.parse(h.out[0]!) as {
		result: string;
		changes: Array<{key: string; to: string}>;
	};
	t.is(result.result, 'changed');
	t.deepEqual(
		result.changes.map(change => [change.key, change.to]),
		[['trotbot', 'permission']],
	);
});

test('watching every space leaves out an attach partner that is down', async t => {
	const h = harness(t, {running: false});
	t.is(
		await h.run('watch', '--until', 'blocked', '--timeout', '1', '--json'),
		0,
	);
	t.like(JSON.parse(h.out[0]!), {result: 'timed_out'});
	t.deepEqual(h.bot.targets, []);
});
