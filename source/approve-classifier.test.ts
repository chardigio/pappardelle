import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	classifierInput,
	classifyCommand,
	defaultClassifierRun,
	type ClassifierRun,
} from './approve-classifier.ts';

const request = {
	tool: 'Bash command',
	description: 'Build the app',
	command: 'bun run build',
	worktree: '/home/u/.worktrees/repo/STA-1',
	cwd: '/home/u/.worktrees/repo/STA-1',
	tempRoots: ['/tmp/'],
};

const answering =
	(stdout: string, status = 0): ClassifierRun =>
	async () => ({status, stdout});

const verdict = (structured: unknown) =>
	JSON.stringify({result: '', structured_output: structured});

test('a yes from the model approves, with its reason', async t => {
	t.deepEqual(
		await classifyCommand(
			request,
			answering(verdict({approve: true, reason: 'a local build'})),
		),
		{kind: 'approve', reason: 'a local build'},
	);
});

test('a no from the model holds, with its reason', async t => {
	t.deepEqual(
		await classifyCommand(
			request,
			answering(verdict({approve: false, reason: 'it deploys'})),
		),
		{kind: 'hold', reason: 'the approval check said no: it deploys'},
	);
});

test('a check that gives no clear answer is unavailable, not a no', async t => {
	const runs: ClassifierRun[] = [
		answering(verdict({approve: false})),
		answering(verdict({approve: 'yes', reason: 'x'})),
		answering(verdict(undefined)),
		answering('not json'),
		answering(verdict({approve: true, reason: 'x'}), 1),
		async () => {
			throw new Error('spawn claude ENOENT');
		},
	];
	const verdicts = await Promise.all(
		runs.map(async run => classifyCommand(request, run)),
	);
	t.true(verdicts.every(verdict => verdict.kind === 'unavailable'));
});

test('a check that fails to run is tried once more', async t => {
	let calls = 0;
	const flaky: ClassifierRun = async () => {
		calls++;
		return calls === 1
			? {status: 1, stdout: ''}
			: {status: 0, stdout: verdict({approve: true, reason: 'fine'})};
	};
	t.deepEqual(await classifyCommand(request, flaky), {
		kind: 'approve',
		reason: 'fine',
	});
	t.is(calls, 2);

	let failures = 0;
	await classifyCommand(request, async () => {
		failures++;
		return {status: 1, stdout: ''};
	});
	t.is(failures, 2);
});

test('the model is told the tool, where the agent works and which dirs are temp', t => {
	t.is(
		classifierInput(request),
		[
			'Tool: Bash command',
			'Purpose: Build the app',
			'Worktree: /home/u/.worktrees/repo/STA-1',
			'Working directory: /home/u/.worktrees/repo/STA-1',
			'Temp directories: /tmp/',
			'Call:',
			'bun run build',
		].join('\n'),
	);
});

test('a check that outlives its deadline ends then, even if a child keeps its output open', async t => {
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-'));
	t.teardown(() => {
		fs.rmSync(bin, {recursive: true, force: true});
	});
	fs.writeFileSync(
		path.join(bin, 'claude'),
		'#!/bin/sh\nsleep 3 &\nsleep 30\n',
		{
			mode: 0o755,
		},
	);
	const path0 = process.env['PATH'];
	process.env['PATH'] = `${bin}:${path0 ?? ''}`;
	t.teardown(() => {
		process.env['PATH'] = path0;
	});
	const started = Date.now();
	await t.throwsAsync(defaultClassifierRun([], '', 300), {
		message: 'timed out after 0.3s',
	});
	t.true(Date.now() - started < 5000);
});
