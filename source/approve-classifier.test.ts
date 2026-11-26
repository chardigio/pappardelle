import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {
	agyClassifierArgs,
	classifierBackend,
	classifierInput,
	classifyWithConfig,
	DEFAULT_AGY_CLASSIFIER_MODEL,
	parseClassifierOutput,
	spawnClassifier,
	type SpawnClassifier,
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
	(stdout: string, status = 0): SpawnClassifier =>
	async () => ({status, stdout});

const verdict = (structured: unknown) =>
	JSON.stringify({result: '', structured_output: structured});

test('a yes from the model approves, with its reason', async () => {
	expect(
		await classifyWithConfig(request, {
			spawn: answering(verdict({approve: true, reason: 'a local build'})),
		}),
	).toStrictEqual({kind: 'approve', reason: 'a local build'});
});

test('a no from the model holds, with its reason', async () => {
	expect(
		await classifyWithConfig(request, {
			spawn: answering(verdict({approve: false, reason: 'it deploys'})),
		}),
	).toStrictEqual({
		kind: 'hold',
		reason: 'the approval check said no: it deploys',
	});
});

test('a check that gives no clear answer is unavailable, not a no', async () => {
	const spawns: SpawnClassifier[] = [
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
		spawns.map(async spawn => classifyWithConfig(request, {spawn})),
	);
	expect(verdicts.every(v => v.kind === 'unavailable')).toBe(true);
});

test('a check that fails to run is tried once more', async () => {
	let calls = 0;
	const flaky: SpawnClassifier = async () => {
		calls++;
		return calls === 1
			? {status: 1, stdout: ''}
			: {status: 0, stdout: verdict({approve: true, reason: 'fine'})};
	};
	expect(await classifyWithConfig(request, {spawn: flaky})).toStrictEqual({
		kind: 'approve',
		reason: 'fine',
	});
	expect(calls).toBe(2);

	let failures = 0;
	await classifyWithConfig(request, {
		async spawn() {
			failures++;
			return {status: 1, stdout: ''};
		},
	});
	expect(failures).toBe(2);
});

test('the model is told the tool, where the agent works and which dirs are temp', () => {
	expect(classifierInput(request)).toBe(
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

test('a check that outlives its deadline ends then, even if a child keeps its output open', async () => {
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-'));
	teardown(() => {
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
	teardown(() => {
		process.env['PATH'] = path0;
	});
	const started = Date.now();
	await rejectionOf(spawnClassifier('claude', [], '', 300)).then(error => {
		expect(error.message).toBe('timed out after 0.3s');
	});
	expect(Date.now() - started < 5000).toBe(true);
});

test('classifierBackend accepts bare claude/agy or absolute paths and rejects relative paths', () => {
	expect(classifierBackend('claude')).toBe('claude');
	expect(classifierBackend('agy')).toBe('agy');
	expect(classifierBackend('/usr/local/bin/agy')).toBe('agy');
	expect(classifierBackend('bin/claude')).toBe(null);
	expect(classifierBackend('./agy')).toBe(null);
	expect(classifierBackend('codex')).toBe(null);
});

test('parseClassifierOutput parses agy 1.5.x JSON envelopes and fails closed on malformed output', () => {
	const agyEnvelope = JSON.stringify({
		conversation_id: '74fbc901-a4e2-4af0-93c1-0e2b4e8381ac',
		status: 'SUCCESS',
		response: '{"approve":true,"reason":"local write"}',
		duration_seconds: 4.1,
		num_turns: 2,
		structured_output: {approve: true, reason: 'local write'},
	});
	expect(parseClassifierOutput(agyEnvelope)).toStrictEqual({
		kind: 'approve',
		reason: 'local write',
	});
	expect(
		parseClassifierOutput(
			JSON.stringify({
				status: 'SUCCESS',
				structured_output: {approve: false, reason: 'deletes root'},
			}),
		),
	).toStrictEqual({
		kind: 'hold',
		reason: 'the approval check said no: deletes root',
	});
	expect(parseClassifierOutput('{}').kind).toBe('unavailable');
	expect(parseClassifierOutput('{"structured_output":null}').kind).toBe(
		'unavailable',
	);
});

test('classifyWithConfig falls back from claude ENOENT to agy, does not mask non-ENOENT errors, and honors explicit config', async () => {
	const enoent = Object.assign(new Error('spawn claude ENOENT'), {
		code: 'ENOENT',
	});
	const calls: Array<{command: string; args: string[]; input: string}> = [];
	const fallbackSpawn: SpawnClassifier = async (command, args, input) => {
		calls.push({command, args, input});
		if (command === 'claude') throw enoent;
		return {
			status: 0,
			stdout: JSON.stringify({
				status: 'SUCCESS',
				structured_output: {approve: true, reason: 'safe build'},
			}),
		};
	};

	expect(
		await classifyWithConfig(request, {spawn: fallbackSpawn}),
	).toStrictEqual({kind: 'approve', reason: 'safe build'});
	expect(calls.map(call => call.command)).toStrictEqual(['claude', 'agy']);
	expect(calls[1]!.args).toContain('--disable-slash-commands');
	expect(calls[1]!.args).toContain(DEFAULT_AGY_CLASSIFIER_MODEL);
	expect(calls[1]!.args).toContain('--json-schema');
	expect(calls[1]!.args).toContain('--settings');
	expect(calls[1]!.input).toBe('');

	// Non-ENOENT errors retry claude and do NOT silently switch to agy.
	const nonEnoentCalls: string[] = [];
	const eacces = Object.assign(new Error('spawn claude EACCES'), {
		code: 'EACCES',
	});
	const failVerdict = await classifyWithConfig(request, {
		async spawn(command) {
			nonEnoentCalls.push(command);
			throw eacces;
		},
	});
	expect(failVerdict.kind).toBe('unavailable');
	expect(nonEnoentCalls).toStrictEqual(['claude', 'claude']);

	// Explicit agy config invokes agy directly with the configured model.
	const agyCalls: Array<{command: string; args: string[]}> = [];
	expect(
		await classifyWithConfig(request, {
			config: {command: '/opt/bin/agy', model: 'gemini-4-argon-low'},
			async spawn(command, args) {
				agyCalls.push({command, args});
				return {
					status: 0,
					stdout: verdict({approve: false, reason: 'exfiltrates secrets'}),
				};
			},
		}),
	).toStrictEqual({
		kind: 'hold',
		reason: 'the approval check said no: exfiltrates secrets',
	});
	expect(agyCalls.length).toBe(1);
	expect(agyCalls[0]!.command).toBe('/opt/bin/agy');
	expect(agyCalls[0]!.args).toContain('gemini-4-argon-low');

	// Explicit claude config does NOT fall back to agy even on ENOENT.
	const pinnedCalls: string[] = [];
	const pinnedVerdict = await classifyWithConfig(request, {
		config: {command: 'claude', model: 'sonnet'},
		async spawn(command) {
			pinnedCalls.push(command);
			throw enoent;
		},
	});
	expect(pinnedVerdict.kind).toBe('unavailable');
	expect(pinnedCalls).toStrictEqual(['claude', 'claude']);

	const args = agyClassifierArgs('check this', 'gemini-4-hydrogen-low');
	expect(args.slice(-2)).toStrictEqual(['-p', 'check this']);
});
