/* eslint-disable ava/no-ignored-test-files -- Shared AVA cleanup for native renderer fixtures. */
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
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

/** Polls until `check` holds; `frame` is printed when it never does. */
export async function until(
	check: () => boolean,
	frame?: () => string | undefined,
) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error(`condition never held\n${String(frame?.())}`);
		await delay(10);
	}
}
