import {test, expect, beforeAll} from 'bun:test';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import stringWidth from 'string-width';
import SpaceListItem from './SpaceListItem.tsx';
import {setTmuxVersionProbeForTests} from '../tmux-skin-tone.ts';
import type {SpaceData} from '../types.ts';

// These assertions render the emoji as configured. Pin a tmux version that
// draws skin-tone modifiers correctly so the probe never strips them.
beforeAll(() => {
	setTmuxVersionProbeForTests(async () => '3.7c');
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

async function renderRow(
	emoji: string,
	width: number,
	title: string,
): Promise<string> {
	const space: SpaceData = {
		name: 'TEST-1',
		worktreePath: null,
		profileEmoji: emoji,
		programStatus: {status: 'idle'},
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
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'row', width},
			React.createElement(SpaceListItem, {
				space,
				width,
				isSelected: false,
				layout: 'single_line',
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	await view.unmount();
	return frame;
}

test('every rail emoji has exactly one separator before the status icon', async () => {
	for (const emoji of emojis) {
		const row = await renderRow(emoji, 60, 'Title');
		expect(row.startsWith(' ' + emoji + ' ● TEST-1 '), `Emoji: ${emoji}`).toBe(
			true,
		);
	}
});

test('an empty emoji retains its two-cell slot and separator', async () => {
	const row = await renderRow('', 60, 'Title');
	expect(row.startsWith('    ● TEST-1 ')).toBe(true);
});

test('emoji in the prefix and title keep the status rail on the same row', async () => {
	for (const emoji of emojis) {
		for (const width of [30, 40, 60, 80]) {
			const frame = await renderRow(
				emoji,
				width,
				'Fix ✨ ⭐ ✅ and 👨‍🍳 rendering',
			);
			expect(frame.split('\n').length, `Rendered row: ${frame}`).toBe(1);
			expect(stringWidth(frame) <= width, `Rendered row: ${frame}`).toBe(true);
			expect(frame.includes('✓'), `Rendered row: ${frame}`).toBe(true);
		}
	}
});
