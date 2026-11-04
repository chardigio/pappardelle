import {createElement, type ReactNode} from 'react';
import TuiErrorBoundary from './components/TuiErrorBoundary.tsx';
import {createCliRenderer, type CliRendererConfig} from '@opentui/core';
import {createRoot} from '@opentui/react';

/**
 * tmux doesn't answer the ?2027 grapheme-width query, so OpenTUI would fall
 * back to wcwidth and split emoji clusters that tmux draws as one 2-cell glyph.
 */
export function preferGraphemeWidths() {
	process.env['OPENTUI_FORCE_UNICODE'] ??= '1';
}

/** Each terminal (rail or tmux popup) has its own renderer and input stream. */
export async function renderTui(
	node: ReactNode,
	options: CliRendererConfig = {},
) {
	if (process.env['TMUX']) {
		preferGraphemeWidths();
		// The rail never shows images, and tmux puts the graphics probe's
		// payload in the pane title.
		process.env['OPENTUI_GRAPHICS'] ??= '0';
	}

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
