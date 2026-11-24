import test from 'ava';
import React from 'react';
import {TextAttributes} from '@opentui/core';
import {ManualClock} from '@opentui/core/testing';
import {render} from '../test/helpers/render.ts';
import ClaudeAnimation from './components/ClaudeAnimation.tsx';
import SpaceListItem from './components/SpaceListItem.tsx';

// A multiple of both the spinner's 150 ms and the blink's 500 ms, so both
// clocks start on a tick boundary.
const START = 1500;

const blockedRow = React.createElement(SpaceListItem, {
	space: {
		name: 'PAP-1',
		worktreePath: null,
		programStatus: {status: 'blocked', kind: 'permission'},
	},
	isSelected: false,
	width: 20,
	layout: 'single_line',
});

function scene({spinners = 0, blink = false}) {
	return React.createElement(
		'box',
		{flexDirection: 'column'},
		React.createElement(
			'box',
			{flexDirection: 'row', height: 1},
			...Array.from({length: spinners}, (_, key) =>
				React.createElement(ClaudeAnimation, {key}),
			),
		),
		blink ? blockedRow : null,
	);
}

async function mount(node: React.ReactNode, startAt = START) {
	const clock = new ManualClock();
	clock.setTime(startAt);
	const view = await render(node, {width: 20, height: 2, clock});
	return {
		clock,
		view,
		async advanceTo(time: number) {
			clock.advance(time - clock.now());
			await view.renderOnce();
		},
		spinners: () => view.captureCharFrame().split('\n')[0]!.trim(),
		blinkOn() {
			const span = view.captureSpans().lines[1]!.spans[0]!;
			// eslint-disable-next-line no-bitwise
			return (span.attributes & TextAttributes.INVERSE) !== 0;
		},
	};
}

test('spinners and the blink advance on the renderer clock, and a later spinner joins the running phase', async t => {
	const scene1 = await mount(scene({spinners: 1, blink: true}));
	t.teardown(async () => scene1.view.unmount());
	t.is(scene1.spinners(), '·');
	t.true(scene1.blinkOn());

	await scene1.advanceTo(START + 150);
	t.is(scene1.spinners(), '✢');
	await scene1.view.rerender(scene({spinners: 2, blink: true}));
	t.is(scene1.spinners(), '✢✢');

	await scene1.advanceTo(START + 300);
	t.is(scene1.spinners(), '✳✳');
	t.true(scene1.blinkOn());
	await scene1.advanceTo(START + 500);
	t.false(scene1.blinkOn());
	await scene1.advanceTo(START + 1000);
	t.true(scene1.blinkOn());
});

test('a blink that starts just before a tick boundary stays on for at least half a blink', async t => {
	const scene1 = await mount(scene({blink: true}), START - 10);
	t.teardown(async () => scene1.view.unmount());
	await scene1.advanceTo(START);
	t.true(scene1.blinkOn());
	await scene1.advanceTo(START + 500);
	t.false(scene1.blinkOn());
});

test('a blink that starts after every blink stopped starts on', async t => {
	const scene1 = await mount(scene({blink: true}));
	t.teardown(async () => scene1.view.unmount());
	await scene1.advanceTo(START + 500);
	t.false(scene1.blinkOn());
	await scene1.view.rerender(scene({}));
	await scene1.view.rerender(scene({blink: true}));
	t.true(scene1.blinkOn());
});

test('nothing draws once nothing animates', async t => {
	const scene1 = await mount(scene({spinners: 1, blink: true}));
	t.teardown(async () => scene1.view.unmount());
	const timersBefore = scene1.clock.pendingTimerCount;
	await scene1.advanceTo(START + 150);
	await scene1.view.rerender(scene({}));
	const {frameId} = scene1.view.renderer;
	scene1.clock.advance(2000);
	await scene1.view.flush();
	t.is(scene1.view.renderer.frameId, frameId);
	t.true(scene1.clock.pendingTimerCount < timersBefore);
});
