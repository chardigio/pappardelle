import {createElement, type ReactNode} from 'react';
import TuiErrorBoundary from './components/TuiErrorBoundary.tsx';
import {createCliRenderer, type CliRendererConfig} from '@opentui/core';
import {createRoot} from '@opentui/react';

/** Each terminal (rail or tmux popup) has its own renderer and input stream. */
export async function renderTui(
	node: ReactNode,
	options: CliRendererConfig = {},
) {
	const renderer = await createCliRenderer({
		screenMode: 'alternate-screen',
		// Capture reconciler diagnostics: Bun console writes bypass stderr hooks.
		consoleMode: 'console-overlay',
		externalOutputMode: 'passthrough',
		openConsoleOnError: false,
		targetFps: 60,
		maxFps: 60,
		...options,
	});
	const root = createRoot(renderer);
	root.render(createElement(TuiErrorBoundary, null, node));
	return {renderer, root};
}
