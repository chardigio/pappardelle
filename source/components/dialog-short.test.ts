import {test, expect} from 'bun:test';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import type {LogEntry} from '../logger.ts';
import type {PopupActions, PopupSpec} from '../popup/spec.ts';
import PopupRoot from './PopupRoot.tsx';

const actions: PopupActions = {
	async confirm() {},
	cancel() {},
	async clearErrors() {},
	subscribeErrors: () => () => {},
};

async function frame(spec: PopupSpec, width: number, height: number) {
	const view = await render(
		React.createElement(PopupRoot, {spec, actions, width, height}),
		{width, height},
	);
	const lines = view.lastFrame().split('\n');
	await view.unmount();
	return lines;
}

test('a close dialog too short for its spacing keeps every line of text', async () => {
	for (const height of [10, 11, 12]) {
		const lines = await frame(
			{
				kind: 'close-space',
				props: {spaceName: 'STA-123', currentIssue: null, tracker: null},
			},
			44,
			height,
		);
		const text = lines.join('\n');
		expect(lines.length, `Rendered dialog:\n${text}`).toBe(height);
		for (const line of [
			'Close Space',
			'Close space STA-123?',
			'remain on disk.',
			'to cancel',
		]) {
			expect(
				text.includes(line),
				`${height} rows, missing "${line}":\n${text}`,
			).toBe(true);
		}
	}
});

test('an error list taller than its popup keeps the header and its keys', async () => {
	const errors: LogEntry[] = Array.from({length: 8}, (_, i) => ({
		timestamp: String(i),
		level: 'error',
		component: 'git',
		message: `Deinit failed: Failing hook ${i}`,
		error: 'boom',
	}));
	const lines = await frame({kind: 'errors', props: {errors}}, 60, 18);
	expect(lines.length).toBe(18);
	expect(lines[2]!, `Rendered dialog:\n${lines.join('\n')}`).toMatch(
		/Errors \(8\) +c clear Esc close/,
	);
	expect(lines.at(-1)!.startsWith('╚'), 'the list stays inside the frame').toBe(
		true,
	);
});
