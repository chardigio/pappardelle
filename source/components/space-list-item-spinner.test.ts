import test from 'ava';
import React from 'react';
import {terminalView} from '../../test/helpers/terminal-view.ts';
import SpaceListItem from './SpaceListItem.tsx';
import {COLORS} from '../types.ts';

const WIDTH = 40;
const SPINNER_FRAMES = new Set(['·', '✢', '✳', '∗', '✻', '✽']);
const ORANGE = Number.parseInt(COLORS.CLAUDE_ORANGE.slice(1), 16);

for (const isSelected of [false, true]) {
	test.serial(
		`the working spinner is orange on ${isSelected ? 'a selected' : 'an unselected'} row`,
		async t => {
			const view = await terminalView(
				React.createElement(SpaceListItem, {
					space: {
						name: 'PAP-1',
						worktreePath: null,
						programStatus: {status: 'working'},
					},
					isSelected,
					width: WIDTH,
					layout: 'single_line',
				}),
				{columns: WIDTH, rows: 2},
			);
			t.teardown(async () => view.dispose());

			const line = view.terminal.buffer.active.getLine(0)!;
			let found = false;
			for (let x = 0; x < WIDTH; x++) {
				const cell = line.getCell(x)!;
				if (!SPINNER_FRAMES.has(cell.getChars())) continue;
				found = true;
				// Under inverse the terminal shows the cell's background as the
				// glyph color, and its foreground as the bar.
				const shown = cell.isInverse()
					? {glyph: cell.getBgColor(), isRgb: cell.isBgRGB()}
					: {glyph: cell.getFgColor(), isRgb: cell.isFgRGB()};
				t.true(shown.isRgb);
				t.is(shown.glyph, ORANGE);
				if (isSelected) t.true(cell.isFgDefault());
			}

			t.true(found);
		},
	);
}
