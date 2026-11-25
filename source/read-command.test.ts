import {test, expect} from 'bun:test';
import {formatTurns, parseTurns, turnsJson} from './read-command.ts';

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
