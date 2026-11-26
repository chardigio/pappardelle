import path from 'node:path';
import {test, expect} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {
	parseAgentScreen,
	parseAgyQuota,
	parseResetTime,
} from './agent-screen.ts';

// Captured from real Claude Code (2.1.319, 2.1.327, 2.1.330, 2.1.331) and Codex
// (0.166, 0.170) sessions.
const NOW = new Date(2026, 10, 9, 12, 0);
const screen = (name: string, now = NOW) =>
	parseAgentScreen(agentScreenFixture(name), now);

test('a Bash prompt gives its command and which options approve once or for good', () => {
	const {permission, question} = screen('claude-permission-bash');
	expect(question).toBe(null);
	expect(permission).toMatchObject({
		tool: 'Bash command',
		subagent: null,
		description: 'Compute checksum of greet.js',
		command: 'cksum greet.js',
		question: 'Do you want to proceed?',
	});
	expect(
		permission?.options.map(option => [option.number, option.kind]),
	).toStrictEqual([
		[1, 'approve_once'],
		[2, 'approve_always'],
		[3, 'approve_always'],
		[4, 'deny'],
	]);
	expect(permission?.options[0]?.selected).toBe(true);
});

test('a prompt from a subagent names the subagent', () => {
	expect(screen('claude-permission-subagent').permission).toMatchObject({
		tool: 'Bash command',
		subagent: 'general-purpose',
		command: 'cksum greet.js',
	});
});

test("a command of several lines is read without Claude's bar down its left", () => {
	expect(screen('claude-permission-multiline').permission).toMatchObject({
		tool: 'Bash command',
		description: 'Remove old scratch directory and print done',
		command: 'SP=/tmp/q-sasrepro2/scratch\nrm -rf "$SP/old"\necho done',
		cutOff: false,
	});
});

test('a prompt taller than the screen is cut off, with no tool and only the end of its command', () => {
	const {permission} = screen('claude-permission-cut-off');
	expect(permission).toMatchObject({
		tool: '',
		description: '',
		question: 'Do you want to proceed?',
		cutOff: true,
	});
	expect(permission!.command).toMatch(/^creates them\.\n\n## Cleanup\n/);
	expect(permission!.command).toMatch(/\n- three\nEOF$/);
	expect(permission?.options.map(option => option.kind)).toStrictEqual([
		'approve_once',
		'deny',
	]);
});

test('an Edit prompt gives the file and the diff', () => {
	const {permission} = screen('claude-permission-edit');
	expect(permission?.tool).toBe('Edit file');
	expect(permission?.question).toBe(
		'Do you want to make this edit to greet.js?',
	);
	expect(permission?.description).toBe('greet.js');
	expect(permission!.command).toMatch(/^1 {2}export function greet/);
	expect(permission!.command).toMatch(/2 \+ {2}return `Hi, \$\{name\}!`;/);
	expect(permission?.options.map(option => option.kind)).toStrictEqual([
		'approve_once',
		'approve_always',
		'deny',
	]);
});

test('a question dialog gives its tabs, question and answers', () => {
	const two = screen('claude-question-two');
	expect(two.permission).toBe(null);
	expect(two.question).toStrictEqual({
		tabs: ['Color', 'Fruit'],
		question: 'What is your favorite color?',
		options: [
			{
				number: 1,
				label: 'Red',
				kind: 'other',
				selected: true,
				description: 'Red',
			},
			{
				number: 2,
				label: 'Blue',
				kind: 'other',
				selected: false,
				description: 'Blue',
			},
			{
				number: 3,
				label: 'Green',
				kind: 'other',
				selected: false,
				description: 'Green',
			},
		],
		multiSelect: false,
		textOption: {number: 4, text: '', open: false},
		cursor: 1,
	});
	expect(screen('claude-question-two-right').question?.question).toBe(
		'What is your favorite fruit?',
	);
	expect(screen('claude-question-one').question?.tabs).toStrictEqual(['Color']);
});

test("a question over several lines is read whole, without Claude's bar, with each option's description", () => {
	const {question} = screen('claude-question-wrapped');
	expect(question?.tabs).toStrictEqual(['Cache strategy']);
	expect(question?.question).toBe(
		'Which caching strategy should the image proxy use for thumbnails generated on demand, given that the origin is slow and the CDN bills per request?',
	);
	expect(question?.options[0]).toStrictEqual({
		number: 1,
		label: 'Aggressive CDN caching (Recommended)',
		kind: 'other',
		selected: true,
		description:
			'Cache thumbnails at the CDN with long TTLs and immutable URLs keyed by size and params. Repeat requests skip the slow origin and cut per-request billing sharply.',
	});
	expect(question?.options.map(option => option.label)).toStrictEqual([
		'Aggressive CDN caching (Recommended)',
		'Proxy-local disk cache',
		'Short TTL with revalidation',
		'Pre-generate on upload',
	]);
	expect(question?.textOption?.number).toBe(5);
});

test('a spinner means working; the done line after a turn does not', () => {
	expect(screen('claude-working').spinner).toBe(true);
	expect(screen('claude-idle').spinner).toBe(false);
	expect(
		parseAgentScreen('• Working (12s • esc to interrupt)', NOW).spinner,
	).toBe(true);
	expect(screen('claude-idle').permission).toBe(null);
});

test('a Codex usage limit gives its reset, joined across wrapped lines', () => {
	for (const name of ['codex-limit-narrow', 'codex-limit-wide']) {
		const {usageLimit} = screen(name);
		expect(usageLimit?.resetText, `${name}`).toBe('Nov 14th, 2026 7:50 AM');
		expect(usageLimit?.resetAt).toStrictEqual(new Date(2026, 10, 14, 7, 50));
		expect(usageLimit?.passed).toBe(false);
	}

	expect(
		screen('codex-limit-narrow', new Date(2026, 10, 14, 8, 0)).usageLimit
			?.passed,
	).toBe(true);
});

test('a usage limit that work has continued past is over', () => {
	const capture = [
		'■ You’ve hit your usage limit. Try again at 4:28 AM.',
		'› continue',
		'• Ran ls',
	].join('\n');
	expect(parseAgentScreen(capture, NOW).usageLimit).toBe(null);
});

test('a bare reset time up to six hours past has passed; older means tomorrow', () => {
	const at = (hour: number) => new Date(2026, 10, 9, hour, 0);
	expect(parseResetTime('4:28 AM', at(6))).toStrictEqual(
		new Date(2026, 10, 9, 4, 28),
	);
	expect(parseResetTime('4:28 AM', at(11))).toStrictEqual(
		new Date(2026, 10, 10, 4, 28),
	);
	expect(parseResetTime('12:05 PM', at(9))).toStrictEqual(
		new Date(2026, 10, 9, 12, 5),
	);
	expect(parseResetTime('12:05 AM', at(1))).toStrictEqual(
		new Date(2026, 10, 9, 0, 5),
	);
});

test('the input box is empty under its dim placeholder and holds a typed draft', () => {
	expect(screen('codex-limit-narrow').composer).toBe('');
	expect(screen('codex-draft').composer).toBe('a draft I have not sent yet');
	expect(screen('claude-placeholder').composer).toBe('');
	expect(screen('claude-idle').composer).toBe('');
	expect(screen('claude-draft').composer).toBe('a draft I have not sent yet');
});

test("Claude's suggested prompt is no draft and is left out of the screen text", () => {
	const {composer, lines} = screen('claude-suggestion');
	expect(composer).toBe('');
	expect(lines.some(line => line.trimEnd() === '❯')).toBe(true);
	expect(lines.some(line => line.trimEnd() === '❯ fix it')).toBe(false);
	expect(
		screen('claude-draft').lines.some(line => line.includes('a draft')),
	).toBe(true);
});

test("Claude's input box is found under a rule that carries the session name", () => {
	const suggestion = screen('claude-suggestion-named');
	expect(suggestion.composer).toBe('');
	expect(
		suggestion.lines.some(line => line.includes("what's in calc.py")),
	).toBe(false);
	expect(screen('claude-draft-named').composer).toBe(
		'a draft I have not sent yet',
	);
});

test("a command typed in Claude's shell mode is a draft that starts with !", () => {
	expect(screen('claude-shell-draft').composer).toBe('!ls -la');
	const empty = screen('claude-shell-empty');
	expect(empty.composer).toBe('');
	expect(empty.lines.some(line => line.includes('Try "edit'))).toBe(false);
	expect(screen('claude-shell-empty-history').composer).toBe('');
});

test("a message echoed into Claude's transcript is not taken for Codex's composer", () => {
	const echo =
		'\u001B[2m\u001B[37m›\u001B[0m \u001B[2m\u001B[37mMessage from @sous-chef\u001B[3m: keep going\u001B[0m';
	const capture = agentScreenFixture('claude-suggestion-named');
	const {composer, lines} = parseAgentScreen(`${echo}\n${capture}`, NOW);
	expect(composer).toBe('');
	expect(lines.some(line => line.includes('Message from @sous-chef'))).toBe(
		true,
	);
	expect(lines.some(line => line.includes("what's in calc.py"))).toBe(false);
});

test("a Codex dialog holds the keyboard, so there's no composer to read", () => {
	const wide = screen('codex-limit-wide');
	expect(wide.codexDialog).toMatchObject({
		kind: 'model_switch',
		title: 'Switch to gpt-6-luna for lower credit usage?',
	});
	expect(wide.composer).toBe(null);
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
	expect(trust.codexDialog).toMatchObject({kind: 'other'});
});

test("a permission option's wrapped label is read whole", () => {
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
	expect(permission?.options[1]?.label).toBe(
		'Yes, and switch to accept edits for this session; Yes, and always allow access to /tmp/q-a for this session (shift+tab)',
	);
	expect(permission?.options[2]?.label).toBe('No');
});

test('a same-day reset with a one-digit hour is read', () => {
	const now = new Date(2026, 10, 9, 8, 0);
	const {usageLimit} = parseAgentScreen(
		[
			"■ You've hit your usage limit. Upgrade to Pro, or try again at 9:31 AM.",
			'',
			'› Ask Codex to do anything',
		].join('\n'),
		now,
	);
	expect(usageLimit?.resetText).toBe('9:31 AM');
	expect(usageLimit?.resetAt).toStrictEqual(new Date(2026, 10, 9, 9, 31));
});

test("a question dialog's Submit step is still a question", () => {
	const capture = [
		'←  ☒ Color  ☒ Fruit  ✔ Submit  →',
		'',
		'Review your answers',
		'',
		' ● What is your favorite color?',
		'   → Blue',
		'           ',
		'Ready to submit your answers?',
		'',
		'❯ 1. Submit answers',
		'  2. Cancel',
	].join('\n');
	expect(parseAgentScreen(capture, NOW).question).toMatchObject({
		question: 'Ready to submit your answers?',
		options: [
			{number: 1, label: 'Submit answers', kind: 'other', selected: true},
			{number: 2, label: 'Cancel', kind: 'other', selected: false},
		],
	});
});

test('the first seconds of a Claude turn, before its timer shows, are working', () => {
	expect(parseAgentScreen('· Warping…', NOW).spinner).toBe(true);
	expect(
		parseAgentScreen('✻ Cogitated for 17s · done 7:32 AM', NOW).spinner,
	).toBe(false);
});

test("a Codex dialog's title is its bold heading, and the highlight is the option Enter takes", () => {
	expect(screen('codex-trust').codexDialog).toStrictEqual({
		kind: 'other',
		title: 'Folder access',
		options: 2,
		selected: 1,
	});
	expect(screen('codex-trust-down').codexDialog).toMatchObject({selected: 2});
	expect(screen('codex-hooks-review-offer').codexDialog).toMatchObject({
		title: 'Hooks need review',
		options: 3,
		selected: 1,
	});
});

test("Codex's hooks table is a dialog, not a draft", () => {
	const hooks = screen('codex-hooks');
	expect(hooks.codexDialog).toStrictEqual({
		kind: 'other',
		title: 'Hooks',
		options: 0,
		selected: null,
	});
	expect(hooks.composer).toBe(null);
});

test("the Submit step's tabs come from its tab bar, not the answers above the question", () => {
	expect(screen('claude-submit').question?.tabs).toStrictEqual([
		'Color',
		'Fruit',
	]);
});

test('a multi-select question reports which options are ticked', () => {
	const toggled = screen('claude-q-multi-toggled').question!;
	expect(toggled.multiSelect).toBe(true);
	expect(
		toggled.options.map(option => [
			option.number,
			option.label,
			option.checked,
		]),
	).toStrictEqual([
		[1, 'Cheese', true],
		[2, 'Olives', false],
		[3, 'Peppers', true],
		[4, 'Onions', false],
	]);
	expect(toggled.textOption).toStrictEqual({number: 5, text: '', open: false});
	expect(screen('claude-q-multi-two').question).toMatchObject({
		multiSelect: true,
		tabs: ['Toppings', 'Crust'],
	});
	expect(screen('claude-question-two').question!.multiSelect).toBe(false);
});

test('the free-text row says whether it is open and what is typed in it', () => {
	expect(screen('claude-question-two').question!.textOption!.open).toBe(false);
	expect(screen('claude-q-text-selected').question?.textOption).toStrictEqual({
		number: 4,
		text: '',
		open: true,
	});
	const typed = screen('claude-q-text-typed').question!;
	expect(typed.textOption).toStrictEqual({
		number: 4,
		text: 'hello there',
		open: true,
	});
	expect(typed.options.map(option => option.label)).toStrictEqual([
		'Water',
		'Juice',
		'Soda',
	]);
});

test("the review step's answers include a multi-select list", () => {
	expect(screen('claude-q-multi-two-submit').question).toMatchObject({
		question: 'Ready to submit your answers?',
		multiSelect: false,
		textOption: null,
	});
});

test('a command line starting with Tip: inside the box is part of the command', () => {
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
	expect(permission?.command).toBe(
		'  echo hi\n  Tip: ; git push --force origin main',
	);
});

test("the limit notice's words printed by an agent aren't a usage limit", () => {
	const {usageLimit} = parseAgentScreen(
		[
			'● Bash(grep -r usage test/fixtures)',
			"  ⎿  codex.txt:■ You've hit your usage limit. Try again at 4:28 AM.",
			"     ■ You've hit your usage limit. Try again at 4:28 AM.",
		].join('\n'),
		NOW,
	);
	expect(usageLimit).toBe(null);
});

test('a Codex command prompt gives its command, and option 1 approves it once with its own key', () => {
	for (const name of [
		'codex-permission-command',
		'codex-permission-command-narrow',
	]) {
		const {permission, composer} = screen(name);
		expect(permission, `${name}`).toMatchObject({
			tool: 'Bash command',
			command: 'rm -rf node_modules',
			description:
				'Do you approve running `rm -rf node_modules` outside the sandbox?',
			choose: 'shortcut',
			cutOff: false,
		});
		expect(
			permission?.options.map(option => [
				option.number,
				option.kind,
				option.shortcut,
			]),
			`${name}`,
		).toStrictEqual([
			[1, 'approve_once', 'y'],
			[2, 'approve_always', 'p'],
			[3, 'deny', 'esc'],
		]);
		expect(permission?.options[0]?.selected, `${name}`).toBe(true);
		// Its highlighted option starts with the same mark as the input line.
		expect(composer, `${name}`).toBe(null);
	}
});

test('a Codex patch prompt lists every file it would change', () => {
	const {permission} = screen('codex-permission-patch');
	expect(permission?.tool).toBe('Codex edits');
	expect(permission?.files?.map(file => path.basename(file))).toStrictEqual([
		'README.md',
		'greet.js',
	]);
	expect(permission?.options[0]?.kind).toBe('approve_once');
});

test('a Codex prompt whose command is off the screen reads as no command', () => {
	const text = agentScreenFixture('codex-permission-command').replace(
		/ {2}\$ .*\n/,
		'\n',
	);
	expect(parseAgentScreen(text, NOW).permission?.command).toBe('');
});

test('a Codex command with a blank line in it is read whole', () => {
	const text = agentScreenFixture('codex-permission-command').replace(
		/ {2}\$ .*\n/,
		'  $ echo hi\n \n  doctl apps list\n',
	);
	expect(parseAgentScreen(text, NOW).permission?.command).toBe(
		'echo hi\n\ndoctl apps list',
	);
});

test('a Codex prompt left in the scrollback is not the prompt on screen', () => {
	const text = agentScreenFixture('codex-permission-command');
	expect(
		parseAgentScreen(`${text}\n● Done.\n`, NOW).permission?.choose,
	).not.toBe('shortcut');
});

test('Write and Read prompts name their file where the path rule can check it', () => {
	expect(screen('claude-permission-write').permission).toMatchObject({
		tool: 'Create file',
		description: 'farewell.js',
		question: 'Do you want to create farewell.js?',
		choose: 'digit',
	});
	expect(screen('claude-permission-read').permission).toMatchObject({
		tool: 'Read file',
		question: 'Do you want to proceed?',
	});
	expect(screen('claude-permission-read').permission!.command).toMatch(
		/^Read\(\/tmp\/.+\/outside\.txt\)$/,
	);
	// A long Write loses its header, but its question still names the file.
	expect(screen('claude-permission-write-long').permission).toMatchObject({
		cutOff: true,
		question: 'Do you want to create numbers.js?',
	});
});

test("a highlighted Chat about this row in a question is not Claude's input box", () => {
	const {composer, question} = screen('claude-q-chat-selected');
	expect(composer).toBe(null);
	expect(question?.options.map(option => option.label)).toStrictEqual([
		'Red',
		'Blue',
	]);
});

// The echo line is the one Claude drew for a SendMessage, set into a real
// permission capture: an isolated Claude can't be sent one.
test("a message echo above Claude's permission prompt is not read as an input box", () => {
	const {composer, permission, lines} = screen('claude-permission-echo');
	expect(composer).toBe(null);
	expect(permission?.command).toBe('touch made-by-claude.txt');
	expect(
		lines.some(line => line.includes('› Message from @sous-chef: keep going')),
	).toBe(true);
});

test("Codex's empty input box is read under the message it just sent", () => {
	const {composer, lines} = screen('codex-sent');
	expect(composer).toBe('');
	expect(
		lines.some(line => line.startsWith('› reply with just the word three')),
	).toBe(true);
});

test('a long paste collapsed into a placeholder is the draft', () => {
	expect(screen('claude-long-paste').composer).toBe(
		'[Pasted text #1 +39 lines]',
	);
	expect(screen('codex-long-paste').composer).toBe(
		'[Pasted Content 2190 chars]',
	);
});

test('agy idle screens read an empty composer and strip the grey placeholder from lines', () => {
	for (const name of ['agy-idle', 'agy-idle-factory']) {
		const {composer, agyComposer, lines} = screen(name);
		expect(composer).toBe('');
		expect(agyComposer).not.toBe(null);
		expect(lines.some(line => line.trimEnd() === '>')).toBe(true);
		expect(lines.some(line => line.includes('Auto mode:'))).toBe(false);
	}

	const theme256Idle = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[38;5;32m>\u001B[39m \u001B[38;5;246mAuto mode: edits & safe commands auto-approved (shift+tab to cycle)',
			'────────────────────',
		].join('\n'),
		NOW,
	);
	expect(theme256Idle.composer).toBe('');
	expect(theme256Idle.lines.some(line => line.includes('Auto mode:'))).toBe(
		false,
	);

	const truecolorIdle = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[94m>\u001B[0m \u001B[38;2;120;124;128mAsk anything',
			'────────────────────',
		].join('\n'),
		NOW,
	);
	expect(truecolorIdle.composer).toBe('');

	// Active text, pure white/black, chromatic text, and Codex 256-grey must remain drafts.
	for (const styled of [
		'\u001B[38;5;32m>\u001B[39m \u001B[38;5;254mbright draft',
		'\u001B[38;5;32m>\u001B[39m \u001B[38;2;255;255;255mwhite draft',
		'\u001B[38;5;32m>\u001B[39m \u001B[38;2;60;180;200mcyan draft',
	]) {
		const draft = parseAgentScreen(
			['────────────────────', styled, '────────────────────'].join('\n'),
			NOW,
		);
		expect(Boolean(draft.composer)).toBe(true);
	}

	const codexNonDim = parseAgentScreen(
		'› \u001B[38;5;246mcodex typed text\n',
		NOW,
	);
	expect(codexNonDim.composer).toBe('codex typed text');
});

test('agy draft screens read drafts in insert, normal and factory modes, including wrapped lines', () => {
	expect(screen('agy-draft').composer).toBe('draft text not sent yet');
	expect(screen('agy-draft-normal').composer).toBe('draft text not sent yet');
	expect(screen('agy-draft-factory').composer).toBe('factory draft not sent');
	expect(
		screen('agy-draft').lines.some(line =>
			line.includes('draft text not sent yet'),
		),
	).toBe(true);

	const multiline = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[94m>\u001B[39m first line of agy draft',
			'  second line of agy draft',
			'────────────────────',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(multiline.composer).toBe(
		'first line of agy draft\nsecond line of agy draft',
	);
	expect(multiline.agyComposer).not.toBe(null);
});

test('agy transcript prompt echoes are not misread as a composer draft', () => {
	for (const echo of [
		'\u001B[1m\u001B[34m> Run something\u001B[0m',
		'\u001B[0m\u001B[1m\u001B[38;5;39m> Run something\u001B[0m',
	]) {
		const capture = [
			'\u001B[90m────────────────────────────────────────────────────────────\u001B[39m',
			echo,
			'',
			'● Bash(ls)',
			'\u001B[90m────────────────────────────────────────────────────────────\u001B[39m',
		].join('\n');
		expect(parseAgentScreen(capture, NOW).composer).toBe(null);
	}
});

test('agy question lists parse into QuestionDialog and never as codexDialog', () => {
	for (const [name, expectedQuestion] of [
		['agy-question', 'Which color do you choose?'],
		['agy-question-factory', 'Which color do you choose?'],
		['agy-prompt-question', 'Please choose a color:'],
	] as const) {
		const parsed = screen(name);
		expect(parsed.codexDialog).toBe(null);
		expect(parsed.agyDialog).toBe(null);
		expect(parsed.permission).toBe(null);
		expect(parsed.composer).toBe(null);
		expect(parsed.question).toStrictEqual({
			tabs: [],
			question: expectedQuestion,
			options: [
				{number: 1, label: 'red', kind: 'other', selected: true},
				{number: 2, label: 'green', kind: 'other', selected: false},
				{number: 3, label: 'blue', kind: 'other', selected: false},
			],
			multiSelect: false,
			textOption: {number: 4, text: '', open: false},
			cursor: 1,
		});
	}

	const writeInHovered = parseAgentScreen(
		[
			'Question 1/1: Which color do you choose?',
			'  1. red',
			'  2. green',
			'  3. blue',
			'> 4. Write-in...',
			'  ↑/↓ Navigate · enter Write-in · esc Skip',
			'esc to cancel    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(writeInHovered.question?.cursor).toBe(4);
	expect(writeInHovered.question?.textOption).toStrictEqual({
		number: 4,
		text: '',
		open: false,
	});

	const writeInEmpty = parseAgentScreen(
		[
			'Question 1/1: Which color do you choose?',
			'  1. red',
			'  2. green',
			'  3. blue',
			'> 4. Write-in...',
			'',
			'  Your answer:',
			'',
			'  enter Submit · esc Back',
			'esc to cancel    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(writeInEmpty.question?.textOption).toStrictEqual({
		number: 4,
		text: '',
		open: true,
		closeKey: 'Escape',
	});

	const writeInTyped = parseAgentScreen(
		[
			'Question 1/1: Which color do you choose?',
			'  1. red',
			'  2. green',
			'  3. blue',
			'> 4. Write-in...',
			'',
			'  Your answer:',
			'  purple',
			'',
			'  enter Submit · esc Back',
			'esc to cancel    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(writeInTyped.question?.textOption).toStrictEqual({
		number: 4,
		text: 'purple',
		open: true,
		closeKey: 'Escape',
	});

	const scrollbackQuestion = parseAgentScreen(
		[
			agentScreenFixture('agy-question'),
			'● Completed earlier question',
			'────────────────────',
			'>',
			'────────────────────',
		].join('\n'),
		NOW,
	);
	expect(scrollbackQuestion.question).toBe(null);
});

test('agy subagent manage view is flagged as agyDialog and never as codexDialog or question', () => {
	const manage = screen('agy-subagent-manage');
	expect(manage.agyDialog).toBe('subagent_manage');
	expect(manage.codexDialog).toBe(null);
	expect(manage.question).toBe(null);
	expect(manage.permission).toBe(null);
	expect(manage.composer).toBe(null);

	const scrollbackManage = parseAgentScreen(
		[
			agentScreenFixture('agy-subagent-manage'),
			'● Resumed',
			'────────────────────',
			'>',
			'────────────────────',
		].join('\n'),
		NOW,
	);
	expect(scrollbackManage.agyDialog).toBe(null);

	// Subagent detail view after denying/answering stays `subagent_manage` until Escape.
	const postDenyDetail = parseAgentScreen(
		[
			'  main › self',
			'  ● done · Gemini 4 Hydrogen (Medium) · worked 3s · 3 steps',
			'  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand · shift+k kill · esc back',
			'                                                                       auto · Gemini 4 Hydrogen · medium · 1 subagent(s)',
		].join('\n'),
		NOW,
	);
	expect(postDenyDetail.agyDialog).toBe('subagent_manage');
	expect(postDenyDetail.composer).toBe(null);
});

test('agy trust dialog and /artifact review parse as agyDialog with no false draft', () => {
	const trust = screen('agy-trust');
	expect(trust.agyDialog).toBe('trust');
	expect(trust.codexDialog).toBe(null);
	expect(trust.permission).toBe(null);
	expect(trust.question).toBe(null);
	expect(trust.composer).toBe(null);

	for (const effort of ['xhigh', 'max']) {
		const trustEffort = parseAgentScreen(
			agentScreenFixture('agy-trust').replace('· medium', `· ${effort}`),
			NOW,
		);
		expect(trustEffort.agyDialog).toBe('trust');
	}

	const scrollbackTrust = parseAgentScreen(
		[
			agentScreenFixture('agy-trust'),
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(scrollbackTrust.agyDialog).toBe(null);
	expect(scrollbackTrust.composer).toBe('');

	const review = screen('agy-plan-artifact-review');
	expect(review.agyDialog).toBe('artifact_review');
	expect(review.codexDialog).toBe(null);
	expect(review.composer).toBe(null);
	expect(review.agyComposer).toBe(null);

	// The /artifact panel with no pending items uses `p preview ... esc Dismiss`.
	const emptyArtifacts = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'Artifacts',
			'  No artifacts',
			'',
			'Keyboard: ↑/↓ Navigate  p preview  enter open  ctrl+g open in editor  esc Dismiss',
			'',
			'plan · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(emptyArtifacts.agyDialog).toBe('artifact_review');
	expect(emptyArtifacts.composer).toBe(null);

	// Even without the /artifact footer, a `› ` row below an agy composer is not a Codex draft.
	const overlayRow = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'› □ new implementation_plan.md   open  approve reject',
			'plan · Gemini 4 Hydrogen · xhigh',
		].join('\n'),
		NOW,
	);
	expect(overlayRow.agyComposer).not.toBe(null);
	expect(overlayRow.composer).toBe('');
});

test('agy plan approval banner, vim insert, announcement banner and working signals', () => {
	const planApproval = screen('agy-plan-approval');
	expect(planApproval.agyDialog).toBe(null);
	expect(planApproval.composer).toBe('');
	expect(planApproval.agyComposer).toStrictEqual({
		vimInsert: true,
		announcementBanner: false,
		working: false,
		artifactReview: true,
	});

	const planDraft = parseAgentScreen(
		[
			'  1 artifact · /artifact to review',
			'────────────────────',
			'\u001B[94m>\u001B[39m refine step 2',
			'────────────────────',
			'-- INSERT -- ? for shortcuts   plan · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(planDraft.agyComposer?.artifactReview).toBe(true);
	expect(planDraft.composer).toBe('refine step 2');

	const subagentBannerWithArtifact = parseAgentScreen(
		[
			'  1 artifact · /artifact to review',
			' ┃ self needs approval for Bash',
			' ┃ ctrl+k approve · alt+j manage',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'-- INSERT -- ? for shortcuts   plan · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(subagentBannerWithArtifact.agyComposer?.artifactReview).toBe(false);

	expect(screen('agy-idle').agyComposer).toStrictEqual({
		vimInsert: true,
		announcementBanner: true,
		working: false,
		artifactReview: false,
	});

	expect(screen('agy-draft-normal').agyComposer).toStrictEqual({
		vimInsert: false,
		announcementBanner: true,
		working: false,
		artifactReview: false,
	});

	expect(screen('agy-idle-factory').agyComposer).toStrictEqual({
		vimInsert: false,
		announcementBanner: true,
		working: false,
		artifactReview: false,
	});

	const workingInsert = parseAgentScreen(
		[
			'⣾  Running command... 2s',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'-- INSERT -- esc to cancel    auto · Gemini 4 Hydrogen · max',
		].join('\n'),
		NOW,
	);
	expect(workingInsert.agyComposer).toStrictEqual({
		vimInsert: true,
		announcementBanner: false,
		working: true,
		artifactReview: false,
	});

	const workingNormal = parseAgentScreen(
		[
			'⣾  Running command... 2s',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'esc to cancel    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(workingNormal.agyComposer).toStrictEqual({
		vimInsert: false,
		announcementBanner: false,
		working: true,
		artifactReview: false,
	});

	expect(screen('claude-idle').agyComposer).toBe(null);
});

test('parseResetTime parses ISO timestamps and parseAgyQuota filters by model family', () => {
	const iso = '2026-11-24T09:10:11Z';
	expect(parseResetTime(iso, NOW)).toStrictEqual(new Date(iso));
	expect(parseResetTime('2026-99-99T00:00:00Z', NOW)).toBe(null);

	const depleted = [
		'Gemini Models\tWeekly Limit Remaining\t98%\t2026-12-01T04:14:49Z',
		'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
		'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-12-01T04:29:31Z',
	].join('\n');
	expect(
		parseAgyQuota(
			depleted,
			new Date('2026-11-24T08:00:00Z'),
			'gemini-4-hydrogen-medium',
		),
	).toStrictEqual({
		kind: 'limited',
		limit: {
			resetText: '2026-11-24T09:10:11Z',
			resetAt: new Date('2026-11-24T09:10:11Z'),
			passed: false,
		},
	});
	expect(
		parseAgyQuota(depleted, new Date('2026-11-24T09:15:00Z')),
	).toStrictEqual({
		kind: 'limited',
		limit: {
			resetText: '2026-11-24T09:10:11Z',
			resetAt: new Date('2026-11-24T09:10:11Z'),
			passed: true,
		},
	});

	// Depleted Claude/GPT quota must not falsely block a Gemini space (and vice versa).
	const claudeOnlyDepleted = [
		'Gemini Models\tFive Hour Limit Remaining\t56%\t2026-11-24T11:00:00Z',
		'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
	].join('\n');
	expect(
		parseAgyQuota(
			claudeOnlyDepleted,
			new Date('2026-11-24T08:00:00Z'),
			'gemini-4-hydrogen-medium',
		),
	).toStrictEqual({kind: 'available'});
	expect(
		parseAgyQuota(
			claudeOnlyDepleted,
			new Date('2026-11-24T08:00:00Z'),
			'claude-sonnet-4-6',
		),
	).toMatchObject({
		kind: 'limited',
		limit: {resetText: '2026-11-24T09:10:11Z'},
	});
	expect(
		parseAgyQuota(
			claudeOnlyDepleted,
			new Date('2026-11-24T08:00:00Z'),
			'gpt-5',
		),
	).toMatchObject({
		kind: 'limited',
		limit: {resetText: '2026-11-24T09:10:11Z'},
	});

	const bothDepleted = [
		'Gemini Models\tWeekly Limit Remaining\t0%\t2026-12-01T04:14:49Z',
		'Gemini Models\tFive Hour Limit Remaining\t0%\t2026-11-24T09:10:11Z',
	].join('\n');
	expect(
		parseAgyQuota(bothDepleted, new Date('2026-11-24T08:00:00Z')),
	).toMatchObject({
		kind: 'limited',
		limit: {resetText: '2026-12-01T04:14:49Z'},
	});

	const remaining = [
		'Gemini Models\tWeekly Limit Remaining\t98%\t2026-12-01T04:14:49Z',
		'Gemini Models\tFive Hour Limit Remaining\t97%\t2026-11-24T09:14:49Z',
	].join('\n');
	expect(parseAgyQuota(remaining, NOW)).toStrictEqual({kind: 'available'});
	expect(parseAgyQuota('garbage output', NOW)).toStrictEqual({
		kind: 'unparsed',
	});
	expect(parseAgyQuota('', NOW)).toStrictEqual({kind: 'unparsed'});
	expect(
		parseAgyQuota(
			'Gemini Models\tFive Hour Limit Remaining\t0%\tnot-a-timestamp',
			NOW,
		),
	).toStrictEqual({
		kind: 'limited',
		limit: {resetText: 'not-a-timestamp', resetAt: null, passed: false},
	});
});

test('agy Out of credits footer and non-agy/stale notices are ignored, while live agy quota notices match', () => {
	const footer = parseAgentScreen(
		[
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'auto · Gemini 4 Hydrogen · medium · AI: Out of credits',
		].join('\n'),
		NOW,
	);
	expect(footer.usageLimit).toBe(null);

	const outOfCreditsNotice = parseAgentScreen(
		[
			'✕ Out of credits',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(outOfCreditsNotice.usageLimit).toBe(null);

	// Non-agy screens (Claude shell mode, Esc footer, Codex GPT footer) never trigger AGY_LIMIT_NOTICE.
	const claudeShell = parseAgentScreen(
		[
			'────────────────────',
			'! grep "rate limit"',
			'────────────────────',
		].join('\n'),
		NOW,
	);
	expect(claudeShell.usageLimit).toBe(null);
	const claudeWithFooter = parseAgentScreen(
		[
			'Error: rate limit mentioned in file',
			'────────────────────',
			'❯ ',
			'────────────────────',
			'Esc to cancel · Tab to amend',
		].join('\n'),
		NOW,
	);
	expect(claudeWithFooter.usageLimit).toBe(null);

	const codexOutput = parseAgentScreen(
		['■ rate limit docs printed here', '› '].join('\n'),
		NOW,
	);
	expect(codexOutput.usageLimit).toBe(null);
	const codexWithRateLimit = parseAgentScreen(
		[
			'■ rate limit in output',
			'› ',
			'  GPT-6-Astra medium · ~/.worktrees/repo/STA-1',
		].join('\n'),
		NOW,
	);
	expect(codexWithRateLimit.usageLimit).toBe(null);

	const quotaNotice = parseAgentScreen(
		[
			'✕ Quota exhausted for Gemini Models',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(quotaNotice.usageLimit).toStrictEqual({
		resetText: '',
		resetAt: null,
		passed: false,
	});

	for (const clearance of [
		['● Working again'],
		['• Resumed'],
		['\u001B[1m\u001B[34m> continue\u001B[0m'],
		['────────────────────', '\u001B[1m\u001B[34m> continue\u001B[0m'],
	]) {
		const stale = parseAgentScreen(
			[
				'✕ Quota exhausted for Gemini Models',
				...clearance,
				'────────────────────',
				'\u001B[94m>\u001B[39m',
				'────────────────────',
				'auto · Gemini 4 Hydrogen · medium',
			].join('\n'),
			NOW,
		);
		expect(stale.usageLimit).toBe(null);
	}
});

test('agy permission prompts parse Command, Create file, File access (Read vs non-Read) and MCP cleanly', () => {
	const shell = screen('agy-permission-shell');
	expect(shell.agyDialog).toBe(null);
	expect(shell.codexDialog).toBe(null);
	expect(shell.composer).toBe(null);
	expect(shell.permission).toMatchObject({
		tool: 'Bash command',
		subagent: null,
		command: 'printf qa > qa.txt',
		question: 'Run this command?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(
		shell.permission?.options.map(option => [
			option.number,
			option.kind,
			option.selected,
		]),
	).toStrictEqual([
		[1, 'approve_once', true],
		[2, 'deny', false],
	]);

	const shellFactory = screen('agy-permission-shell-factory');
	expect(shellFactory.permission).toMatchObject({
		tool: 'Bash command',
		command: 'printf qa > qa.txt',
		source: 'agy',
		cutOff: false,
	});
	expect(
		shellFactory.permission?.options.map(option => [
			option.number,
			option.kind,
		]),
	).toStrictEqual([
		[1, 'approve_once'],
		[2, 'approve_always'],
		[3, 'approve_always'],
		[4, 'deny'],
	]);

	const truncated = screen('agy-permission-shell-truncated');
	expect(truncated.permission).toMatchObject({
		tool: 'Bash command',
		source: 'agy',
		cutOff: true,
	});
	expect(truncated.permission?.command).toContain('printf 1 >> tall.txt');
	expect(truncated.permission?.command).toContain('⋯ (26 lines hidden)');

	for (const [name, expectedPath] of [
		['agy-permission-edit', '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/x.txt'],
		[
			'agy-permission-edit-factory',
			'/tmp/q-agy-dfac/home/.worktrees/qagy-dfac/qa-a1/x.txt',
		],
	] as const) {
		const edit = screen(name);
		expect(edit.permission, name).toMatchObject({
			tool: 'Create file',
			filePath: expectedPath,
			command: '  1  +  hello',
			question: 'Allow creation of this file?',
			choose: 'digit',
			source: 'agy',
			cutOff: false,
		});
		expect(
			edit.permission?.options.map(option => option.kind),
			name,
		).toStrictEqual(['approve_once', 'deny']);
	}

	const readInside = screen('agy-permission-read');
	expect(readInside.permission).toMatchObject({
		tool: 'Read file',
		filePath: '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/AGENTS.md',
		question: 'Allow access to this file?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(
		readInside.permission?.options.map(option => option.kind),
	).toStrictEqual(['approve_once', 'deny']);

	const readOutside = screen('agy-permission-read-outside');
	expect(readOutside.permission).toMatchObject({
		tool: 'Read file',
		filePath: '/etc/hostname',
		source: 'agy',
		cutOff: false,
	});

	// Non-Read File access must stay `File access`, never `Read file`.
	const writeAccess = parseAgentScreen(
		[
			'File access',
			'────────────────────────────────────────',
			'',
			'Write: /tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/.claude/settings.json',
			'',
			'Allow access to this file?',
			'> 1. Yes, allow access',
			'  2. No, deny access',
			'',
			'  ↑/↓ Navigate',
			'esc to cancel    auto · Gemini 4 Hydrogen · medium',
		].join('\n'),
		NOW,
	);
	expect(writeAccess.permission).toMatchObject({
		tool: 'File access',
		filePath: '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/.claude/settings.json',
		source: 'agy',
	});

	const mcp = screen('agy-permission-mcp');
	expect(mcp.permission).toMatchObject({
		tool: 'MCP',
		description: 'qastub/qa_echo',
		command: 'qastub/qa_echo({"text":"hi"})',
		question: 'Allow calling this tool?',
		choose: 'digit',
		source: 'agy',
		cutOff: false,
	});
	expect(mcp.permission?.options.map(option => option.kind)).toStrictEqual([
		'approve_once',
		'deny',
		'deny',
		'deny',
	]);
});

test('agy /config and /model pickers parse as agyDialog with composer null', () => {
	for (const [name, expected] of [
		['agy-config', 'config'],
		['agy-config-factory', 'config'],
		['agy-model-picker', 'model_picker'],
	] as const) {
		const parsed = screen(name);
		expect(parsed.agyDialog, name).toBe(expected);
		expect(parsed.codexDialog, name).toBe(null);
		expect(parsed.permission, name).toBe(null);
		expect(parsed.composer, name).toBe(null);
		expect(parsed.agyComposer, name).toBe(null);
	}
});

test('agy subagent approval banners parse subagent, tool, command, vimInsert and shortcuts', () => {
	const bash = screen('agy-subagent-banner-1');
	expect(bash.agyDialog).toBe(null);
	expect(bash.composer).toBe(null);
	expect(bash.permission).toStrictEqual({
		tool: 'Bash command',
		subagent: 'self',
		description: '',
		command: 'printf a > sub-1.txt',
		question: 'self needs approval for Bash',
		options: [
			{
				number: 1,
				label: 'Yes, approve',
				kind: 'approve_once',
				selected: true,
				shortcut: 'C-k',
			},
			{
				number: 2,
				label: 'No, deny',
				kind: 'deny',
				selected: false,
				shortcut: 'M-j',
			},
		],
		choose: 'shortcut',
		source: 'agy',
		subagentBanner: {vimInsert: true},
		cutOff: false,
	});

	const mcp = screen('agy-subagent-banner-mcp');
	expect(mcp.permission).toMatchObject({
		tool: 'qastub/qa_echo',
		subagent: 'self',
		command: '{"text":"sub-1"}',
		choose: 'shortcut',
		source: 'agy',
		subagentBanner: {vimInsert: false},
		cutOff: false,
	});

	const wrapped = parseAgentScreen(
		[
			' ┃ research needs approval for Read',
			' ┃ ────────────────────',
			' ┃',
			' ┃ ● Read(/tmp/q-agy-d/home/.worktrees/qagy-d/',
			' ┃   qa-b2/AGENTS.md)',
			' ┃',
			' ┃ ctrl+k approve · alt+j manage',
			'────────────────────',
			'\u001B[94m>\u001B[39m',
			'────────────────────',
			'? for shortcuts    auto · Gemini 4 Hydrogen · medium · 1 subagent(s)',
		].join('\n'),
		NOW,
	);
	expect(wrapped.permission).toMatchObject({
		tool: 'Read file',
		subagent: 'research',
		filePath: '/tmp/q-agy-d/home/.worktrees/qagy-d/qa-b2/AGENTS.md',
		subagentBanner: {vimInsert: false},
	});
});
