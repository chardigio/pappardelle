import {createElement, useEffect, type ReactNode} from 'react';
import {deliverHeldKeysAtOnce} from './lone-escape.ts';
import {isInTmux} from './tmux.ts';
import TuiErrorBoundary from './components/TuiErrorBoundary.tsx';
import {
	createCliRenderer,
	parseKeypress,
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

/** Runs `onMounted` once everything under it has mounted its effects. */
function Mounted({
	onMounted,
	children,
}: {
	onMounted: () => void;
	children?: ReactNode;
}): ReactNode {
	useEffect(() => {
		onMounted();
	}, [onMounted]);
	return children;
}

/** Each terminal (rail or tmux popup) has its own renderer and input stream. */
export async function renderTui(
	node: ReactNode,
	options: CliRendererConfig = {},
	onFailedViewClose?: (renderer: CliRenderer) => void,
) {
	// The renderer reads input as soon as it exists, before the tree has
	// mounted anything that listens for keys. Keys typed in that time are kept
	// and delivered once it has.
	const typedAhead: string[] = [];
	const keepKey = (sequence: string): boolean => {
		if (!parseKeypress(sequence)) return false;
		typedAhead.push(sequence);
		return true;
	};

	const renderer = await createCliRenderer({
		screenMode: 'alternate-screen',
		// OpenTUI's overlay would replace console.error with an in-memory cache
		// the rail never shows, hiding React and OpenTUI diagnostics from the log.
		consoleMode: 'disabled',
		externalOutputMode: 'passthrough',
		openConsoleOnError: false,
		environment: isInTmux() ? tmuxRendererEnvironment : {},
		targetFps: 60,
		// A key that lands just after a frame waits for the next one.
		maxFps: 120,
		...options,
		prependInputHandlers: [keepKey, ...(options.prependInputHandlers ?? [])],
	});
	const deliverTypedAhead = () => {
		renderer.removeInputHandler(keepKey);
		for (const sequence of typedAhead.splice(0))
			renderer.keyInput.processParsedKey(parseKeypress(sequence)!);
	};

	if (isInTmux())
		deliverHeldKeysAtOnce(renderer, options.stdin ?? process.stdin);
	const root = createRoot(renderer);
	const onClose = onFailedViewClose && (() => onFailedViewClose(renderer));
	const rerender = (next: ReactNode) =>
		root.render(
			createElement(
				Mounted,
				{onMounted: deliverTypedAhead},
				createElement(TuiErrorBoundary, {onClose}, next),
			),
		);
	rerender(node);
	return {renderer, root, rerender};
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

const quitSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * OpenTUI's remaining default exit signals. The quit signals are handled by
 * `quitOnSignals` instead, so they close the layout like `q` does.
 */
export const rendererExitSignals: NodeJS.Signals[] = [
	'SIGQUIT',
	'SIGABRT',
	'SIGPIPE',
	'SIGBREAK',
	'SIGBUS',
];

/**
 * A terminal closing (SIGHUP) or a kill would otherwise only destroy the
 * renderer and leave the layout's viewer panes behind, or a session holding
 * only viewers that the next `pappardelle` attaches to. Quitting runs once,
 * and the listener stays for the rest of teardown: with none left, a second
 * signal would kill the process before the renderer restores the terminal.
 */
export function quitOnSignals(quit: () => void): void {
	let quitting = false;
	const onSignal = () => {
		if (quitting) return;
		quitting = true;
		quit();
	};

	for (const signal of quitSignals) process.on(signal, onSignal);
}
