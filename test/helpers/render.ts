/* eslint-disable ava/no-ignored-test-files -- Shared AVA cleanup for native renderer fixtures. */
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
