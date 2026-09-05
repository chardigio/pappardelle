import test from 'ava';
import React from 'react';
import {Box} from 'ink';
import {render} from 'ink-testing-library';
import stringWidth from 'string-width';
import {ReadyWorkList, type ReadyWork} from './ReadyWork.tsx';

function renderReady(width: number, prefix: string, title: string): string {
	const issues = Array.from({length: 8}, (_, index) => ({
		identifier: `${prefix}-abc.${index + 1}`,
		title,
		state: {name: 'Open', type: 'unstarted', color: '#00ff00'},
	}));
	const ready: ReadyWork = {
		issues,
		loading: false,
		index: 0,
		identifiers: issues.map(issue => issue.identifier),
		onRow: true,
		openKeyActive: true,
		closeKeyActive: true,
		errorMessage: null,
		closeTarget: null,
		async confirmClose() {},
		cancelClose() {},
	};
	const view = render(
		React.createElement(
			Box,
			{width},
			React.createElement(ReadyWorkList, {
				ready,
				width,
				isFocused: true,
				hasHints: false,
			}),
		),
	);
	const frame = view.lastFrame() ?? '';
	view.unmount();
	return frame;
}

test('eight ready suggestions fit eight rows inside narrow frames', t => {
	for (const width of [20, 30, 40, 60, 90]) {
		for (const prefix of ['bd', 'seatgeek-ticket-management-cli']) {
			for (const title of [
				'Repair the workspace configuration',
				'Fix 界面 🍝\nNext line',
			]) {
				const frame = renderReady(width, prefix, title);
				const lines = frame.split('\n');
				t.is(lines.length, 10, `Rendered frame: ${frame}`);
				for (const line of lines) {
					t.is(stringWidth(line), width, `Rendered frame: ${frame}`);
				}
				t.true(lines[1]!.includes('❯ '), `Rendered frame: ${frame}`);
			}
		}
	}
});

test('title budget follows identifier length and preserves full keys when they fit', t => {
	const short = renderReady(40, 'bd', 'Repair the workspace configuration');
	t.true(
		short.includes('bd-abc.1 Repair the workspace'),
		`Rendered frame: ${short}`,
	);
	const long = renderReady(
		60,
		'seatgeek-ticket-management-cli',
		'Repair the workspace configuration',
	);
	t.true(
		long.includes('seatgeek-ticket-management-cli-abc.1 Repair'),
		`Rendered frame: ${long}`,
	);
});
