import type {ReactNode} from 'react';
import {createCliRenderer, type CliRendererConfig} from '@opentui/core';
import {createRoot} from '@opentui/react';

/** Each terminal (rail or tmux popup) has its own renderer and input stream. */
export async function renderTui(
	node: ReactNode,
	options: CliRendererConfig = {},
) {
	const renderer = await createCliRenderer({
		screenMode: 'alternate-screen',
		consoleMode: 'disabled',
		externalOutputMode: 'passthrough',
		openConsoleOnError: false,
		targetFps: 60,
		maxFps: 60,
		...options,
	});
	const root = createRoot(renderer);
	root.render(node);
	return {renderer, root};
}
