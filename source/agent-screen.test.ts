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

test("a command of several lines is read without Claude's bar down its left", t => {
	t.like(screen('claude-permission-multiline').permission, {
		tool: 'Bash command',
		description: 'Remove old scratch directory and print done',
		command: 'SP=/tmp/q-sasrepro2/scratch\nrm -rf "$SP/old"\necho done',
		cutOff: false,
	});
});

test('a prompt taller than the screen is cut off, with no tool and only the end of its command', t => {
	const {permission} = screen('claude-permission-cut-off');
	t.like(permission, {
		tool: '',
		description: '',
		question: 'Do you want to proceed?',
		cutOff: true,
	});
	t.regex(permission!.command, /^creates them\.\n\n## Cleanup\n/);
	t.regex(permission!.command, /\n- three\nEOF$/);
	t.deepEqual(
		permission?.options.map(option => option.kind),
		['approve_once', 'deny'],
	);
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
		multiSelect: false,
		textOption: {number: 4, text: '', open: false},
		cursor: 1,
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

test('the input box is empty under its dim placeholder and holds a typed draft', t => {
	t.is(screen('codex-limit-narrow').composer, '');
	t.is(screen('codex-draft').composer, 'a draft I have not sent yet');
	t.is(screen('claude-placeholder').composer, '');
	t.is(screen('claude-idle').composer, '');
	t.is(screen('claude-draft').composer, 'a draft I have not sent yet');
});

test("a Codex dialog holds the keyboard, so there's no composer to read", t => {
	const wide = screen('codex-limit-wide');
	t.like(wide.codexDialog, {
		kind: 'model_switch',
		title: 'Switch to gpt-6-luna for lower credit usage?',
	});
	t.is(wide.composer, null);
	const trust = parseAgentScreen(
		[
			'> You are in /tmp/q-a/repo',
			'',
			'  Do you trust the contents of this directory?',
			'',
			'› 1. Yes, continue',
			'  2. No, quit',
			'',
			'  Press enter to continue',
			'  enter continue · esc quit',
		].join('\n'),
		new Date(),
	);
	t.like(trust.codexDialog, {kind: 'other'});
});

test("a permission option's wrapped label is read whole", t => {
	const {permission} = parseAgentScreen(
		[
			'────────',
			' Create file',
			' Do you want to create x.txt?',
			' ❯ 1. Yes',
			'   2. Yes, and switch to accept edits for this session; Yes, and',
			'      always allow access to /tmp/q-a for this session (shift+tab)',
			'   3. No',
			' Esc to cancel · Tab to amend',
		].join('\n'),
		new Date(),
	);
	t.is(
		permission?.options[1]?.label,
		'Yes, and switch to accept edits for this session; Yes, and always allow access to /tmp/q-a for this session (shift+tab)',
	);
	t.is(permission?.options[2]?.label, 'No');
});

test('a same-day reset with a one-digit hour is read', t => {
	const now = new Date(2026, 10, 9, 8, 0);
	const {usageLimit} = parseAgentScreen(
		[
			"■ You've hit your usage limit. Upgrade to Pro, or try again at 9:31 AM.",
			'',
			'› Ask Codex to do anything',
		].join('\n'),
		now,
	);
	t.is(usageLimit?.resetText, '9:31 AM');
	t.deepEqual(usageLimit?.resetAt, new Date(2026, 10, 9, 9, 31));
});

test("a question dialog's Submit step is still a question", t => {
	const capture = [
		'←  ☒ Color  ☒ Fruit  ✔ Submit  →',
		'Review your answers',
		' ● What is your favorite color? → Blue',
		'Ready to submit your answers?',
		'❯ 1. Submit answers',
		'  2. Cancel',
	].join('\n');
	t.like(parseAgentScreen(capture, NOW).question, {
		question: 'Ready to submit your answers?',
		options: [
			{number: 1, label: 'Submit answers', kind: 'other', selected: true},
			{number: 2, label: 'Cancel', kind: 'other', selected: false},
		],
	});
});

test('the first seconds of a Claude turn, before its timer shows, are working', t => {
	t.true(parseAgentScreen('· Warping…', NOW).spinner);
	t.false(parseAgentScreen('✻ Cogitated for 17s · done 7:32 AM', NOW).spinner);
});

test("a Codex dialog's title is its bold heading, and the highlight is the option Enter takes", t => {
	t.deepEqual(screen('codex-trust').codexDialog, {
		kind: 'other',
		title: 'Folder access',
		options: 2,
		selected: 1,
	});
	t.like(screen('codex-trust-down').codexDialog, {selected: 2});
	t.like(screen('codex-hooks-review-offer').codexDialog, {
		title: 'Hooks need review',
		options: 3,
		selected: 1,
	});
});

test("Codex's hooks table is a dialog, not a draft", t => {
	const hooks = screen('codex-hooks');
	t.deepEqual(hooks.codexDialog, {
		kind: 'other',
		title: 'Hooks',
		options: 0,
		selected: null,
	});
	t.is(hooks.composer, null);
});

test("the Submit step's tabs come from its tab bar, not the answers above the question", t => {
	t.deepEqual(screen('claude-submit').question?.tabs, ['Color', 'Fruit']);
});

test('a multi-select question reports which options are ticked', t => {
	const toggled = screen('claude-q-multi-toggled').question!;
	t.true(toggled.multiSelect);
	t.deepEqual(
		toggled.options.map(option => [
			option.number,
			option.label,
			option.checked,
		]),
		[
			[1, 'Cheese', true],
			[2, 'Olives', false],
			[3, 'Peppers', true],
			[4, 'Onions', false],
		],
	);
	t.deepEqual(toggled.textOption, {number: 5, text: '', open: false});
	t.like(screen('claude-q-multi-two').question, {
		multiSelect: true,
		tabs: ['Toppings', 'Crust'],
	});
	t.false(screen('claude-question-two').question!.multiSelect);
});

test('the free-text row says whether it is open and what is typed in it', t => {
	t.false(screen('claude-question-two').question!.textOption!.open);
	t.deepEqual(screen('claude-q-text-selected').question?.textOption, {
		number: 4,
		text: '',
		open: true,
	});
	const typed = screen('claude-q-text-typed').question!;
	t.deepEqual(typed.textOption, {number: 4, text: 'hello there', open: true});
	t.deepEqual(
		typed.options.map(option => option.label),
		['Water', 'Juice', 'Soda'],
	);
});

test("the review step's answers include a multi-select list", t => {
	t.like(screen('claude-q-multi-two-submit').question, {
		question: 'Ready to submit your answers?',
		multiSelect: false,
		textOption: null,
	});
});

test('a command line starting with Tip: inside the box is part of the command', t => {
	const {permission} = parseAgentScreen(
		[
			'────────',
			' Bash command',
			'╌╌╌╌╌╌╌╌',
			'   echo hi',
			'   Tip: ; git push --force origin main',
			'╌╌╌╌╌╌╌╌',
			' Tip: use /permissions to change this',
			' Do you want to proceed?',
			' ❯ 1. Yes',
			'   2. No',
			' Esc to cancel',
		].join('\n'),
		NOW,
	);
	t.is(permission?.command, '  echo hi\n  Tip: ; git push --force origin main');
});

test("the limit notice's words printed by an agent aren't a usage limit", t => {
	const {usageLimit} = parseAgentScreen(
		[
			'● Bash(grep -r usage test/fixtures)',
			"  ⎿  codex.txt:■ You've hit your usage limit. Try again at 4:28 AM.",
			"     ■ You've hit your usage limit. Try again at 4:28 AM.",
		].join('\n'),
		NOW,
	);
	t.is(usageLimit, null);
});
