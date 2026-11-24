import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {type ExecutionContext} from 'ava';
import {
	formatTurns,
	parseTurns,
	readRecentTurns,
	runReadCommand,
	turnsJson,
} from './read-command.ts';

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

function tempFile(t: ExecutionContext, name: string, text: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-read-'));
	t.teardown(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});
	const file = path.join(dir, name);
	fs.writeFileSync(file, text);
	return file;
}

test('a long transcript is read back from its end, and says it is partial', t => {
	// About 3 MB, so the first 1 MB window holds the last turns only.
	const filler = 'x'.repeat(400);
	const entries = Array.from({length: 4000}, (_, index) => [
		user(`prompt ${index} ${filler}`),
		assistant(`reply ${index}`),
	]).flat();
	const file = tempFile(t, 'long.jsonl', jsonl(...entries));
	const {turns, complete} = readRecentTurns(file, 3);
	t.false(complete);
	t.true(turns.length >= 3);
	t.true(turns.length < 4000);
	t.true(turns.at(-1)!.prompt.startsWith('prompt 3999 '));
	t.deepEqual(turns.at(-1)!.replies, ['reply 3999']);
	t.true(turns[0]!.prompt.startsWith('prompt '));
	t.deepEqual(turnsJson('trotbot', turns, 1, complete), {
		issueKey: 'trotbot',
		turns: [turns.at(-1)],
	});
	t.true(
		formatTurns('trotbot', turns, 1, complete).startsWith(
			'trotbot: last 1 turns',
		),
	);
});

test('a short transcript is read whole', t => {
	const file = tempFile(
		t,
		'short.jsonl',
		jsonl(user('one'), assistant('a'), user('two'), assistant('b')),
	);
	const {turns, complete} = readRecentTurns(file, 5);
	t.true(complete);
	t.is(turns.length, 2);
});

test('the session log given is read instead of the newest one in the folder', async t => {
	const own = tempFile(t, 'own.jsonl', jsonl(user('mine'), assistant('ok')));
	const out: string[] = [];
	t.is(
		await runReadCommand({
			issueKey: 'trotbot',
			log: own,
			worktree: null,
			turns: 5,
			json: true,
			out: text => out.push(text),
			err() {},
		}),
		0,
	);
	t.like(JSON.parse(out[0]!), {totalTurns: 1, turns: [{prompt: 'mine'}]});
});

test('a shared folder with no session log reads nothing', async t => {
	const err: string[] = [];
	t.is(
		await runReadCommand({
			issueKey: 'trotbot',
			log: null,
			worktree: null,
			turns: 5,
			json: false,
			out() {},
			err: text => err.push(text),
		}),
		1,
	);
	t.deepEqual(err, ['No conversation log for trotbot']);
});
