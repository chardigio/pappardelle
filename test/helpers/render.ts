/* eslint-disable ava/no-ignored-test-files -- Shared AVA cleanup for native renderer fixtures. */
import {setTimeout as delay} from 'node:timers/promises';
import type {KeyEvent} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import test from 'ava';
import React from 'react';
import {render as renderOpenTui} from './opentui-render.ts';

const views = new Set<Awaited<ReturnType<typeof renderOpenTui>>>();
test.after.always(async () => {
	await Promise.all([...views].map(view => view.unmount()));
});
export async function render(...args: Parameters<typeof renderOpenTui>) {
	const view = await renderOpenTui(...args);
	views.add(view);
	const dispose = view.unmount;
	view.unmount = async () => {
		views.delete(view);
		await dispose();
	};
	return view;
}

/** The key events OpenTUI's parser makes of `bytes`, as useKeyboard delivers them. */
export async function keysFromStdin(bytes: string): Promise<KeyEvent[]> {
	const received: KeyEvent[] = [];
	function Listener() {
		useKeyboard(event => received.push(event));
		return React.createElement('text', null, 'listening');
	}

	const view = await render(React.createElement(Listener));
	try {
		await view.stdin.write(bytes);
		return received;
	} finally {
		await view.unmount();
	}
}

/** Polls until `check` holds; `frame` is printed when it never does. */
export async function until(
	check: () => boolean,
	frame?: () => string | undefined,
) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) {
			const dump = frame?.();
			throw new Error(
				dump === undefined
					? 'condition never held'
					: `condition never held\n${dump}`,
			);
		}

		await delay(10);
	}
}
