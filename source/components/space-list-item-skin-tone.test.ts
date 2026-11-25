import {test, expect} from 'bun:test';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import stringWidth from 'string-width';
import SpaceListItem from './SpaceListItem.tsx';
import {
	resolveTmuxSkinTone,
	setTmuxVersionProbeForTests,
} from '../tmux-skin-tone.ts';
import type {SpaceData} from '../types.ts';

// tmux 3.6 draws a skin-tone emoji as 4 cells while OpenTUI lays it out as 2.
// This measures the frame the way tmux 3.6 does, so a row that fits OpenTUI's
// layout but wraps in tmux fails here.
const tmux36Width = (text: string): number =>
	stringWidth(text) + 2 * (text.match(/[\u{1F3FB}-\u{1F3FF}]/gu)?.length ?? 0);

function makeSpace(title: string): SpaceData {
	return {
		name: 'TEST-1',
		worktreePath: null,
		profileEmoji: '💪🏼',
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
}

async function mountRow(width: number, title: string) {
	return render(
		React.createElement(
			'box',
			{flexDirection: 'row', width},
			React.createElement(SpaceListItem, {
				space: makeSpace(title),
				width,
				isSelected: false,
				layout: 'single_line',
			}),
		),
	);
}

function setInsideTmux(insideTmux: boolean): void {
	if (insideTmux) {
		process.env['TMUX'] = '/tmp/fake-socket,1,0';
	} else {
		delete process.env['TMUX'];
	}
}

async function renderRow(
	tmuxVersion: string | null,
	width: number,
	title: string,
	insideTmux = true,
): Promise<string> {
	setInsideTmux(insideTmux);
	setTmuxVersionProbeForTests(async () => tmuxVersion);
	await resolveTmuxSkinTone();
	const view = await mountRow(width, title);
	const frame = view.lastFrame() ?? '';
	await view.unmount();
	return frame;
}

test('tmux 3.6 strips the modifier and keeps the rail on one line', async () => {
	for (const width of [30, 40, 60, 80]) {
		const frame = await renderRow('3.6', width, 'Ship 👍🏽 and 💪🏿 fixes');
		expect(frame.split('\n').length, `Rendered row: ${frame}`).toBe(1);
		expect(tmux36Width(frame) <= width, `Rendered row: ${frame}`).toBe(true);
		expect(frame.startsWith(' 💪 ● TEST-1'), `Rendered row: ${frame}`).toBe(
			true,
		);
		expect(frame.includes('✓'), `Rendered row: ${frame}`).toBe(true);
	}
});

test('tmux 3.6a keeps the full grapheme at its 2-cell width', async () => {
	for (const version of ['3.6a', '3.7c', 'next-3.9']) {
		for (const width of [30, 40, 60, 80]) {
			const frame = await renderRow(version, width, 'Ship 👍🏽 and 💪🏿 fixes');
			expect(frame.split('\n').length, `Rendered row: ${frame}`).toBe(1);
			expect(stringWidth(frame) <= width, `Rendered row: ${frame}`).toBe(true);
			expect(frame.startsWith(' 💪🏼 ● TEST-1'), `Rendered row: ${frame}`).toBe(
				true,
			);
			expect(frame.includes('✓'), `Rendered row: ${frame}`).toBe(true);
		}
	}
});

test('outside tmux the full grapheme is kept', async () => {
	for (const width of [30, 40, 60, 80]) {
		const frame = await renderRow('3.6', width, 'Ship 👍🏽 and 💪🏿 fixes', false);
		expect(frame.split('\n').length, `Rendered row: ${frame}`).toBe(1);
		expect(stringWidth(frame) <= width, `Rendered row: ${frame}`).toBe(true);
		expect(frame.startsWith(' 💪🏼 ● TEST-1'), `Rendered row: ${frame}`).toBe(
			true,
		);
	}
});

test('a row renders before the tmux version is known and refreshes once it is', async () => {
	setInsideTmux(true);
	let finish!: (version: string) => void;
	setTmuxVersionProbeForTests(
		async () =>
			new Promise(resolve => {
				finish = resolve;
			}),
	);
	const view = await mountRow(60, 'Ship 👍🏽 fixes');
	const before = view.lastFrame();
	expect(before.startsWith(' 💪🏼 ● TEST-1'), `Rendered row: ${before}`).toBe(
		true,
	);
	expect(finish, 'mounting the row starts the probe').toBeTruthy();
	finish('3.6');
	await resolveTmuxSkinTone();
	await view.renderOnce();
	const after = view.lastFrame();
	expect(after.startsWith(' 💪 ● TEST-1'), `Rendered row: ${after}`).toBe(true);
	expect(after.includes('Ship 👍 fixes'), `Rendered row: ${after}`).toBe(true);
	await view.unmount();
});
