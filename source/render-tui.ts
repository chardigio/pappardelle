import {createElement, type ReactNode} from 'react';
import {isInTmux} from './tmux.ts';
import TuiErrorBoundary from './components/TuiErrorBoundary.tsx';
import {
	createCliRenderer,
	type CliRenderer,
	type CliRendererConfig,
} from '@opentui/core';
import {createRoot} from '@opentui/react';

/**
 * tmux doesn't answer the ?2027 grapheme-width query, so OpenTUI would fall
 * back to wcwidth and split emoji clusters that tmux draws as one 2-cell glyph.
 * The rail never shows images, and tmux puts the graphics probe's payload in
 * the pane title. Passed to the renderer rather than set on process.env so
 * agent sessions spawned from the rail don't inherit them.
 */
export const tmuxRendererEnvironment: Readonly<Record<string, string>> = {
	OPENTUI_FORCE_UNICODE: '1',
	OPENTUI_GRAPHICS: '0',
};

/** Each terminal (rail or tmux popup) has its own renderer and input stream. */
export async function renderTui(
	node: ReactNode,
	options: CliRendererConfig = {},
	onFailedViewClose?: (renderer: CliRenderer) => void,
) {
	const renderer = await createCliRenderer({
		screenMode: 'alternate-screen',
		// OpenTUI's overlay would replace console.error with an in-memory cache
		// the rail never shows, hiding React and OpenTUI diagnostics from the log.
		consoleMode: 'disabled',
		externalOutputMode: 'passthrough',
		openConsoleOnError: false,
		environment: isInTmux() ? tmuxRendererEnvironment : {},
		targetFps: 60,
		maxFps: 60,
		...options,
	});
	const root = createRoot(renderer);
	const onClose = onFailedViewClose && (() => onFailedViewClose(renderer));
	root.render(createElement(TuiErrorBoundary, {onClose}, node));
	return {renderer, root};
}

/**
 * OpenTUI's own Ctrl+C exit only destroys the renderer, which would leave the
 * layout's viewer panes behind. Pair with `exitOnCtrlC: false`.
 */
export function quitOnCtrlC(renderer: CliRenderer, quit: () => void): void {
	renderer.keyInput.on('keypress', event => {
		if (event.ctrl && event.name === 'c') quit();
	});
}
