import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {parseAgentScreen, parseResetTime} from './agent-screen.ts';

// Captured from real Claude Code 2.1.319 and Codex 0.166 sessions.
const fixtures = path.join(
	import.meta.dirname,
	'..',
	'test',
	'fixtures',
	'agent-screens',
);
const NOW = new Date(2026, 10, 9, 12, 0);
const screen = (name: string, now = NOW) =>
	parseAgentScreen(
		fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8'),
		now,
	);

test('a Bash prompt gives its command and which options approve once or for good', t => {
	const {permission, question} = screen('claude-permission-bash');
	t.is(question, null);
	t.like(permission, {
		tool: 'Bash command',
		subagent: null,
		description: 'Compute checksum of greet.js',
		command: 'cksum greet.js',
		question: 'Do you want to proceed?',
	});
	t.deepEqual(
		permission?.options.map(option => [option.number, option.kind]),
		[
			[1, 'approve_once'],
			[2, 'approve_always'],
			[3, 'approve_always'],
			[4, 'deny'],
		],
	);
	t.true(permission?.options[0]?.selected);
});

test('a prompt from a subagent names the subagent', t => {
	t.like(screen('claude-permission-subagent').permission, {
		tool: 'Bash command',
		subagent: 'general-purpose',
		command: 'cksum greet.js',
	});
});

test('an Edit prompt gives the file and the diff', t => {
	const {permission} = screen('claude-permission-edit');
	t.is(permission?.tool, 'Edit file');
	t.is(permission?.question, 'Do you want to make this edit to greet.js?');
	t.is(permission?.description, 'greet.js');
	t.regex(permission!.command, /^1 {2}export function greet/);
	t.regex(permission!.command, /2 \+ {2}return `Hi, \$\{name\}!`;/);
	t.deepEqual(
		permission?.options.map(option => option.kind),
		['approve_once', 'approve_always', 'deny'],
	);
});

test('a question dialog gives its tabs, question and answers', t => {
	const two = screen('claude-question-two');
	t.is(two.permission, null);
	t.deepEqual(two.question, {
		tabs: ['Color', 'Fruit'],
		question: 'What is your favorite color?',
		options: [
			{number: 1, label: 'Red', kind: 'other', selected: true},
			{number: 2, label: 'Blue', kind: 'other', selected: false},
			{number: 3, label: 'Green', kind: 'other', selected: false},
		],
	});
	t.is(
		screen('claude-question-two-right').question?.question,
		'What is your favorite fruit?',
	);
	t.deepEqual(screen('claude-question-one').question?.tabs, ['Color']);
});

test('a spinner means working; the done line after a turn does not', t => {
	t.true(screen('claude-working').spinner);
	t.false(screen('claude-idle').spinner);
	t.true(parseAgentScreen('• Working (12s • esc to interrupt)', NOW).spinner);
	t.is(screen('claude-idle').permission, null);
});

test('a Codex usage limit gives its reset, joined across wrapped lines', t => {
	for (const name of ['codex-limit-narrow', 'codex-limit-wide']) {
		const {usageLimit} = screen(name);
		t.is(usageLimit?.resetText, 'Nov 14th, 2026 7:50 AM', `${name}`);
		t.deepEqual(usageLimit?.resetAt, new Date(2026, 10, 14, 7, 50));
		t.false(usageLimit?.passed);
	}

	t.true(
		screen('codex-limit-narrow', new Date(2026, 10, 14, 8, 0)).usageLimit
			?.passed,
	);
});

test('a usage limit that work has continued past is over', t => {
	const capture = [
		'■ You’ve hit your usage limit. Try again at 4:28 AM.',
		'› continue',
		'• Ran ls',
	].join('\n');
	t.is(parseAgentScreen(capture, NOW).usageLimit, null);
});

test('a bare reset time up to six hours past has passed; older means tomorrow', t => {
	const at = (hour: number) => new Date(2026, 10, 9, hour, 0);
	t.deepEqual(parseResetTime('4:28 AM', at(6)), new Date(2026, 10, 9, 4, 28));
	t.deepEqual(parseResetTime('4:28 AM', at(11)), new Date(2026, 10, 10, 4, 28));
	t.deepEqual(parseResetTime('12:05 PM', at(9)), new Date(2026, 10, 9, 12, 5));
	t.deepEqual(parseResetTime('12:05 AM', at(1)), new Date(2026, 10, 9, 0, 5));
});

test('the Codex composer is empty under its dim placeholder and holds a typed draft', t => {
	t.is(screen('codex-limit-narrow').composer, '');
	t.is(screen('codex-draft').composer, 'a draft I have not sent yet');
});

test("a Codex dialog holds the keyboard, so there's no composer to read", t => {
	const wide = screen('codex-limit-wide');
	t.true(wide.codexDialog);
	t.is(wide.composer, null);
});
