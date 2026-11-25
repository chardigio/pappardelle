import {test, expect} from 'bun:test';
import React from 'react';
import {parseColor} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import {buildKillDoneConfirmContent} from '../kill-done-spaces.ts';
import {buildUpdateConfirmContent} from '../update-action.ts';
import {buildConfigFixConfirmContent} from '../config-migration.ts';
import type {PopupActions, PopupSpec} from '../popup/spec.ts';
import {terminalColor} from '../tui-style.ts';
import PopupRoot from './PopupRoot.tsx';

const actions: PopupActions = {
	async confirm() {},
	cancel() {},
	async clearErrors() {},
	subscribeErrors: () => () => {},
};

async function corner(spec: PopupSpec) {
	const view = await render(
		React.createElement(PopupRoot, {spec, actions, width: 60, height: 14}),
		{width: 60, height: 14},
	);
	const span = view.captureSpans().lines[0]!.spans[0]!;
	await view.unmount();
	return span;
}

test('confirmations that remove spaces keep the red double frame', async () => {
	for (const spec of [
		{kind: 'confirm', props: buildKillDoneConfirmContent(3)},
		{
			kind: 'close-space',
			props: {spaceName: 'PAP-1', currentIssue: null, tracker: null},
		},
	] as PopupSpec[]) {
		const span = await corner(spec);
		expect(span.text[0], `kind ${spec.kind}`).toBe('╔');
		expect(
			span.fg.equals(parseColor(terminalColor('red'))),
			`kind ${spec.kind}`,
		).toBe(true);
	}
});

test('other confirmations get a neutral frame in the default foreground', async () => {
	for (const props of [
		buildUpdateConfirmContent(
			{installedVersion: '1.0.0', latestVersion: '1.1.0'},
			'1.0.0',
		),
		buildConfigFixConfirmContent('a reason'),
	]) {
		const span = await corner({kind: 'confirm', props});
		expect(span.text[0], `dialog ${props.title}`).toBe('╭');
		expect(
			span.fg.equals(parseColor(terminalColor())),
			`dialog ${props.title}`,
		).toBe(true);
	}
});
