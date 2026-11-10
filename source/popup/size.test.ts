import test from 'ava';
import stringWidth from 'string-width';
import {buildHelpLines, buildHelpRows} from '../components/help-rows.ts';
import {popupSize} from './size.ts';

const client = {cols: 200, rows: 50};

test('a confirm is as tall as its wrapped content plus chrome', t => {
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
	t.deepEqual(size, {width: 72, height: 11});
});

test('a confirm on a narrow client wraps into more rows', t => {
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

	t.is(size.width, 30);
	// The 47-column hint wraps onto three 24-column lines.
	t.is(size.height, 4 + 2 + 2 + 3);
});

test('a confirm taller than the client stays two rows short of it', t => {
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

	t.is(size.height, 18);
});

test('help height is capped two rows short of the client', t => {
	const size = popupSize(
		{
			kind: 'help',
			props: {customKeybindings: [], commitSha: 'abc1234'},
		},
		{cols: 200, rows: 20},
	);

	t.is(size.height, 18);
});

test('help grows a section for custom commands', t => {
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

	t.is(withCustom.height, base.height + 4);
});

test('help is wide enough for every heading, the status legend included', t => {
	const size = popupSize(
		{kind: 'help', props: {customKeybindings: [], commitSha: 'abc1234'}},
		client,
	);
	const headings = buildHelpLines(buildHelpRows([])).flatMap(line =>
		line.kind === 'heading' ? [line.text] : [],
	);

	const borderAndPadding = 6;
	for (const heading of headings) {
		t.true(
			stringWidth(heading) <= size.width - borderAndPadding,
			`fits: ${heading}`,
		);
	}
});

test('scrolling views take 80% of the client', t => {
	t.deepEqual(
		popupSize({kind: 'issue', props: {argv: ['bd'], title: 'bd-1'}}, client),
		{width: 160, height: 40},
	);
});

test('a close-space popup leaves room for the state row', t => {
	const size = popupSize(
		{kind: 'close-space', props: {spaceName: 'bd-a1b2', currentIssue: null}},
		client,
	);

	// The confirm above, plus the state row and its margin.
	t.deepEqual(size, {width: 72, height: 13});
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

test('an agent profile popup stays two rows short of the client', t => {
	// tmux rejects a popup as tall as an 80x20 client with a status line.
	t.is(popupSize(agentProfiles(32), {cols: 80, rows: 20}).height, 18);
});

test('an agent profile popup is never narrower than its hint', t => {
	// 60% of 80 columns would wrap the hint onto a row the height doesn't budget.
	t.is(popupSize(agentProfiles(5), {cols: 80, rows: 40}).width, 53);
	t.is(popupSize(agentProfiles(5), {cols: 200, rows: 40}).width, 120);
});
