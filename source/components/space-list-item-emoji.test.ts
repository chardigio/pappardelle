import test from 'ava';
import React from 'react';
import {Box} from 'ink';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import SpaceListItem from './SpaceListItem.tsx';
import {setTmuxVersionProbeForTests} from '../tmux-skin-tone.ts';
import type {SpaceData} from '../types.ts';

// These assertions render the emoji as configured. Pin a tmux version that
// draws skin-tone modifiers correctly so the probe never strips them.
test.before(() => {
	setTmuxVersionProbeForTests(() => '3.7c');
});

const emojis = [
	'✨',
	'⭐',
	'✅',
	'❤',
	'🍝',
	'🐝',
	'⚙️',
	'🖲️',
	'❤️',
	'👨‍🍳',
	'👍🏽',
];

function renderRow(emoji: string, width: number, title: string): string {
	const space: SpaceData = {
		name: 'TEST-1',
		worktreePath: null,
		profileEmoji: emoji,
		claudeStatus: 'waiting_for_input',
		linearIssue: {
			identifier: 'TEST-1',
			title,
			state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
		},
		railStatus: {
			pipeline: 'passing',
			unresolvedCommentCount: 3,
			hasConflict: false,
		},
	};
	const view = render(
		React.createElement(
			Box,
			{width},
			React.createElement(SpaceListItem, {
				space,
				width,
				isSelected: false,
				layout: 'single_line',
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	view.unmount();
	return frame;
}

test('every rail emoji has exactly one separator before the status icon', t => {
	for (const emoji of emojis) {
		t.true(
			renderRow(emoji, 60, 'Title').startsWith(emoji + ' ● TEST-1 '),
			`Emoji: ${emoji}`,
		);
	}
});

test('an empty emoji retains its two-cell slot and separator', t => {
	t.true(renderRow('', 60, 'Title').startsWith('   ● TEST-1 '));
});

test('emoji in the prefix and title keep the status rail on the same row', t => {
	for (const emoji of emojis) {
		for (const width of [30, 40, 60, 80]) {
			const frame = renderRow(emoji, width, 'Fix ✨ ⭐ ✅ and 👨‍🍳 rendering');
			t.is(frame.split('\n').length, 1, `Rendered row: ${frame}`);
			t.true(stringWidth(frame) <= width, `Rendered row: ${frame}`);
			t.true(frame.includes('✓'), `Rendered row: ${frame}`);
		}
	}
});
