import test from 'ava';
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

test('a turn is a typed prompt and the assistant text after it', t => {
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
	t.deepEqual(turns, [
		{
			prompt: 'fix the tests',
			ts: '2026-10-17T12:00:00.000Z',
			replies: ['Looking.', 'Fixed.'],
		},
		{prompt: 'ship it', ts: '2026-10-17T12:00:00.000Z', replies: ['Shipped.']},
	]);
});

test('injected meta text, sidechains, other entry types and bad lines are skipped', t => {
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
	t.deepEqual(
		turns.map(turn => turn.prompt),
		['real prompt'],
	);
});

test('assistant text before any prompt has no turn to join', t => {
	t.deepEqual(parseTurns(jsonl(assistant('hello'))), []);
});

test('prompts and replies are cut at 500 characters', t => {
	const long = 'x'.repeat(800);
	const [turn] = parseTurns(jsonl(user(long), assistant(long)));
	t.is(turn!.prompt.length, 500);
	t.is(turn!.replies[0]!.length, 500);
});

test('text and JSON output keep only the last N turns', t => {
	const turns = parseTurns(
		jsonl(user('one'), assistant('a'), user('two'), assistant('b')),
	);
	const text = formatTurns('STA-1', turns, 1);
	t.true(text.startsWith('STA-1: 2 turns, last 1'));
	t.false(text.includes('one'));
	t.regex(text, /user: two\n {2}assistant: b$/);
	t.deepEqual(turnsJson('STA-1', turns, 1), {
		issueKey: 'STA-1',
		totalTurns: 2,
		turns: [turns[1]],
	});
});
