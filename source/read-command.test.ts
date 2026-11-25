import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import type {PappardelleConfig} from './config.ts';
import {
	formatTurns,
	parseAgyTurns,
	parseTurns,
	runReadCommand,
	turnsJson,
} from './read-command.ts';
import {extractRecapFromJsonl} from './space-state.ts';

const jsonl = (...entries: unknown[]) =>
	entries.map(entry => JSON.stringify(entry)).join('\n');

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
	type: 'user',
	timestamp: '2026-10-17T12:00:00.000Z',
	message: {content},
	...extra,
});
const assistant = (content: unknown) => ({
	type: 'assistant',
	message: {content},
});

test('a turn is a typed prompt and the assistant text after it', () => {
	const turns = parseTurns(
		jsonl(
			user('fix the tests'),
			assistant([{type: 'text', text: 'Looking.'}, {type: 'tool_use'}]),
			user([{type: 'tool_result', content: 'ok'}]),
			assistant([{type: 'text', text: 'Fixed.'}]),
			user([{type: 'text', text: 'ship it'}]),
			assistant('Shipped.'),
		),
	);
	expect(turns).toStrictEqual([
		{
			prompt: 'fix the tests',
			ts: '2026-10-17T12:00:00.000Z',
			replies: ['Looking.', 'Fixed.'],
		},
		{prompt: 'ship it', ts: '2026-10-17T12:00:00.000Z', replies: ['Shipped.']},
	]);
});

test('injected meta text, sidechains, other entry types and bad lines are skipped', () => {
	const turns = parseTurns(
		[
			JSON.stringify(user('real prompt')),
			JSON.stringify(
				user([{type: 'text', text: 'skill body'}], {isMeta: true}),
			),
			JSON.stringify(user('subagent', {isSidechain: true})),
			JSON.stringify({type: 'custom-title', customTitle: 'x'}),
			'not json',
			'',
		].join('\n'),
	);
	expect(turns.map(turn => turn.prompt)).toStrictEqual(['real prompt']);
});

test('assistant text before any prompt has no turn to join', () => {
	expect(parseTurns(jsonl(assistant('hello')))).toStrictEqual([]);
});

test('prompts and replies are cut at 500 characters', () => {
	const long = 'x'.repeat(800);
	const [turn] = parseTurns(jsonl(user(long), assistant(long)));
	expect(turn!.prompt.length).toBe(500);
	expect(turn!.replies[0]!.length).toBe(500);
});

test('text and JSON output keep only the last N turns', () => {
	const turns = parseTurns(
		jsonl(user('one'), assistant('a'), user('two'), assistant('b')),
	);
	const text = formatTurns('STA-1', turns, 1);
	expect(text.startsWith('STA-1: 2 turns, last 1')).toBe(true);
	expect(text.includes('one')).toBe(false);
	expect(text).toMatch(/user: two\n {2}assistant: b$/);
	expect(turnsJson('STA-1', turns, 1)).toStrictEqual({
		issueKey: 'STA-1',
		totalTurns: 2,
		turns: [turns[1]],
	});
});

test('parseAgyTurns extracts USER_INPUT and PLANNER_RESPONSE replies and skips noise', () => {
	const turns = parseAgyTurns(
		jsonl(
			{
				step_index: 0,
				source: 'SYSTEM',
				type: 'SYSTEM_MESSAGE',
				created_at: '2026-11-24T10:00:00Z',
				content: 'system instructions',
			},
			{
				step_index: 1,
				source: 'MODEL',
				type: 'PLANNER_RESPONSE',
				created_at: '2026-11-24T10:00:01Z',
				content: 'stray before prompt',
			},
			{
				step_index: 2,
				source: 'USER_EXPLICIT',
				type: 'USER_INPUT',
				created_at: '2026-11-24T10:01:00Z',
				content:
					'<USER_REQUEST>\nfix the tests\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
			},
			{
				step_index: 3,
				source: 'MODEL',
				type: 'PLANNER_RESPONSE',
				created_at: '2026-11-24T10:01:05Z',
				thinking: 'hmm',
				tool_calls: [{name: 'run_command'}],
			},
			{
				step_index: 4,
				source: 'MODEL',
				type: 'GENERIC',
				created_at: '2026-11-24T10:01:06Z',
				content: 'tool output',
			},
			{
				step_index: 5,
				source: 'MODEL',
				type: 'PLANNER_RESPONSE',
				created_at: '2026-11-24T10:01:10Z',
				content: 'Fixed them.',
			},
			{
				step_index: 6,
				source: 'USER_EXPLICIT',
				type: 'USER_INPUT',
				created_at: '2026-11-24T10:02:00Z',
				content: `<USER_REQUEST>\n${'a'.repeat(700)}`,
			},
			{
				step_index: 7,
				source: 'MODEL',
				type: 'PLANNER_RESPONSE',
				created_at: '2026-11-24T10:02:05Z',
				content: 'b'.repeat(700),
			},
			'not json',
		),
	);
	expect(turns.length).toBe(2);
	expect(turns[0]).toStrictEqual({
		prompt: 'fix the tests',
		ts: '2026-11-24T10:01:00Z',
		replies: ['Fixed them.'],
	});
	expect(turns[1]!.prompt.length).toBe(500);
	expect(turns[1]!.replies[0]!.length).toBe(500);
});

test('runReadCommand reads agy transcript.jsonl and never falls back to stale Claude logs', async () => {
	const home = tempDir('read-agy-');
	const worktree = path.join(home, 'wt', 'STA-9');
	const state = testState({home});
	const {spaceState, agentSessions} = state.daos;

	// Stale Claude log from before switching to agy.
	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const staleClaude = path.join(
		home,
		'.claude',
		'projects',
		encoded,
		'old.jsonl',
	);
	fs.mkdirSync(path.dirname(staleClaude), {recursive: true});
	fs.writeFileSync(staleClaude, jsonl(user('stale claude'), assistant('nope')));

	await spaceState.write('STA-9', {
		agentProfile: {name: 'argon', isClaude: false},
	});
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'STA',
		agent_profiles: {argon: {command: 'agy'}},
		profiles: {dev: {display_name: 'Dev'}},
	};

	// Before agy records a conversationId or transcript, must fail instead of reading Claude's log.
	const errLines: string[] = [];
	const missingCode = await runReadCommand({
		issueKey: 'STA-9',
		worktree,
		spaceState,
		agentSessions,
		config,
		home,
		turns: 5,
		json: true,
		out() {},
		err: line => errLines.push(line),
	});
	expect(missingCode).toBe(1);
	expect(errLines).toStrictEqual(['No conversation log for STA-9']);

	fs.mkdirSync(path.dirname(agentSessions.file('STA-9')), {recursive: true});
	fs.writeFileSync(
		agentSessions.file('STA-9'),
		JSON.stringify({argon: {session_id: 'conv-agy-1', pid: 10, started: null}}),
	);
	const noFileCode = await runReadCommand({
		issueKey: 'STA-9',
		worktree,
		spaceState,
		agentSessions,
		config,
		home,
		turns: 5,
		json: true,
		out() {},
		err() {},
	});
	expect(noFileCode).toBe(1);

	const agyLog = path.join(
		home,
		'.gemini',
		'antigravity-cli',
		'brain',
		'conv-agy-1',
		'.system_generated',
		'logs',
		'transcript.jsonl',
	);
	fs.mkdirSync(path.dirname(agyLog), {recursive: true});
	fs.writeFileSync(
		agyLog,
		jsonl(
			{
				type: 'USER_INPUT',
				source: 'USER_EXPLICIT',
				created_at: '2026-11-24T12:00:00Z',
				content: '<USER_REQUEST>\nhello agy\n</USER_REQUEST>',
			},
			{
				type: 'PLANNER_RESPONSE',
				source: 'MODEL',
				created_at: '2026-11-24T12:00:05Z',
				content: 'hello human',
			},
		),
	);

	const outLines: string[] = [];
	const okCode = await runReadCommand({
		issueKey: 'STA-9',
		worktree,
		spaceState,
		agentSessions,
		config,
		home,
		turns: 5,
		json: true,
		out: line => outLines.push(line),
		err() {},
	});
	expect(okCode).toBe(0);
	expect(JSON.parse(outLines.join('\n'))).toStrictEqual({
		issueKey: 'STA-9',
		totalTurns: 1,
		turns: [
			{
				prompt: 'hello agy',
				ts: '2026-11-24T12:00:00Z',
				replies: ['hello human'],
			},
		],
	});
	expect(await extractRecapFromJsonl(agyLog, 'agy')).toStrictEqual({
		lastPrompt: 'hello agy',
		lastAssistantExcerpt: 'hello human',
	});
});

test('runReadCommand does not fall back to stale Claude logs for Codex or custom non-Claude spaces', async () => {
	const home = tempDir('read-other-');
	const worktree = path.join(home, 'wt', 'STA-10');
	const state = testState({home});
	const {spaceState, agentSessions} = state.daos;

	const encoded = worktree.replaceAll('/', '-').replaceAll('.', '-');
	const staleClaude = path.join(
		home,
		'.claude',
		'projects',
		encoded,
		'old.jsonl',
	);
	fs.mkdirSync(path.dirname(staleClaude), {recursive: true});
	fs.writeFileSync(staleClaude, jsonl(user('stale claude'), assistant('nope')));

	for (const agentProfile of [
		{name: 'codex', isClaude: false},
		{name: 'custom-agent', isClaude: false},
	]) {
		await spaceState.write('STA-10', {agentProfile});
		const errLines: string[] = [];
		const code = await runReadCommand({
			issueKey: 'STA-10',
			worktree,
			spaceState,
			agentSessions,
			config: null,
			home,
			turns: 5,
			json: true,
			out() {},
			err: line => errLines.push(line),
		});
		expect(code).toBe(1);
		expect(errLines).toStrictEqual(['No conversation log for STA-10']);
	}
});
