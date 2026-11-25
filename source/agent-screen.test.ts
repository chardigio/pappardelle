import path from 'node:path';
import {test, expect} from 'bun:test';
import {agentScreenFixture} from '../test/helpers/agent-screens.ts';
import {parseAgentScreen, parseResetTime} from './agent-screen.ts';

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
