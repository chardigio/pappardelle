import {test, expect} from 'bun:test';
import stringWidth from 'string-width';
import {buildHelpLines, buildHelpRows} from '../components/help-rows.ts';
import {popupSize} from './size.ts';

const client = {cols: 200, rows: 50};

test('a confirm is as tall as its wrapped content plus chrome', () => {
	const size = popupSize(
		{
			kind: 'confirm',
			props: {
				title: 'Close Space',
				message: 'Close space bd-a1b2?',
				detail: 'The worktree and git branch will remain on disk.',
				isDestructive: true,
			},
		},
		client,
	);

	// Border and padding 4, title 1 + margin 1, message 1 + margin 1,
	// detail 1 + margin 1, hint 1.
	expect(size).toStrictEqual({width: 72, height: 11});
});

test('a confirm on a narrow client wraps into more rows', () => {
	const size = popupSize(
		{
			kind: 'confirm',
			props: {
				title: 'Close Space',
				message: 'Close space bd-a1b2?',
				isDestructive: true,
			},
		},
		{cols: 34, rows: 50},
	);

	expect(size.width).toBe(30);
	// The 47-column hint wraps onto three 24-column lines.
	expect(size.height).toBe(4 + 2 + 2 + 3);
});

test('a confirm taller than the client stays two rows short of it', () => {
	const size = popupSize(
		{
			kind: 'confirm',
			props: {
				title: 'Rewrite config',
				message: 'word '.repeat(200),
				isDestructive: false,
			},
		},
		{cols: 80, rows: 20},
	);

	expect(size.height).toBe(18);
});

test('help height is capped two rows short of the client', () => {
	const size = popupSize(
		{
			kind: 'help',
			props: {customKeybindings: [], commitSha: 'abc1234'},
		},
		{cols: 200, rows: 20},
	);

	expect(size.height).toBe(18);
});

test('help grows a section for custom commands', () => {
	const base = popupSize(
		{kind: 'help', props: {customKeybindings: [], commitSha: 'abc1234'}},
		client,
	);
	const withCustom = popupSize(
		{
			kind: 'help',
			props: {
				customKeybindings: [{key: 'z', name: 'Zap', run: 'true'}],
				commitSha: 'abc1234',
			},
		},
		client,
	);

	expect(withCustom.height).toBe(base.height + 4);
});

test('help is wide enough for every heading, the status legend included', () => {
	const size = popupSize(
		{kind: 'help', props: {customKeybindings: [], commitSha: 'abc1234'}},
		client,
	);
	const headings = buildHelpLines(buildHelpRows([])).flatMap(line =>
		line.kind === 'heading' ? [line.text] : [],
	);

	const borderAndPadding = 6;
	for (const heading of headings) {
		expect(
			stringWidth(heading) <= size.width - borderAndPadding,
			`fits: ${heading}`,
		).toBe(true);
	}
});

test('scrolling views take 80% of the client', () => {
	expect(
		popupSize({kind: 'issue', props: {argv: ['bd'], title: 'bd-1'}}, client),
	).toStrictEqual({width: 160, height: 40});
});

test('a close-space popup leaves room for the state row', () => {
	const size = popupSize(
		{kind: 'close-space', props: {spaceName: 'bd-a1b2', currentIssue: null}},
		client,
	);

	// The confirm above, plus the state row and its margin.
	expect(size).toStrictEqual({width: 72, height: 13});
});

const agentProfiles = (count: number) => ({
	kind: 'agent-profile' as const,
	props: {
		options: Array.from({length: count}, (_, i) => ({
			name: `agent-${i}`,
			source: '.pappardelle.yml',
		})),
		selected: 'agent-0',
		profileDefault: 'agent-0',
	},
});

test('an agent profile popup stays two rows short of the client', () => {
	// tmux rejects a popup as tall as an 80x20 client with a status line.
	expect(popupSize(agentProfiles(32), {cols: 80, rows: 20}).height).toBe(18);
});

test('an agent profile popup is never narrower than its hint', () => {
	// 60% of 80 columns would wrap the hint onto a row the height doesn't budget.
	expect(popupSize(agentProfiles(5), {cols: 80, rows: 40}).width).toBe(53);
	expect(popupSize(agentProfiles(5), {cols: 200, rows: 40}).width).toBe(120);
});
