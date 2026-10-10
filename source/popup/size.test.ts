import test from 'ava';
import {popupSize, wrappedLineCount} from './size.ts';

const client = {cols: 200, rows: 50};

test('wrapping breaks on spaces and splits words longer than the line', t => {
	t.is(wrappedLineCount('short', 10), 1);
	t.is(wrappedLineCount('aaaa bbbb cccc', 9), 2);
	t.is(wrappedLineCount('a'.repeat(25), 10), 3);
	t.is(wrappedLineCount('one\ntwo', 10), 2);
});

test('a confirm is as tall as its wrapped content plus chrome', t => {
	const size = popupSize(
		{
			kind: 'confirm',
			props: {
				title: 'Close Space',
				message: 'Close space bd-a1b2?',
				detail: 'The worktree and git branch will remain on disk.',
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
			props: {title: 'Close Space', message: 'Close space bd-a1b2?'},
		},
		{cols: 34, rows: 50},
	);

	t.is(size.width, 30);
	// The 47-column hint wraps onto three 24-column lines.
	t.is(size.height, 4 + 2 + 2 + 3);
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

test('scrolling views take 80% of the client', t => {
	t.deepEqual(
		popupSize({kind: 'issue', props: {argv: ['bd'], title: 'bd-1'}}, client),
		{width: 160, height: 40},
	);
});
