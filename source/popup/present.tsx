import React from 'react';
import {render} from 'ink';
import PopupRoot from '../components/PopupRoot.tsx';
import {createNormalizingStdin} from '../components/kitty-keyboard.ts';
import type {PopupActions, PopupSpec} from './spec.ts';
import type {PopupTerminal} from './terminal.ts';

/**
 * Render the dialog into a popup's terminal from the TUI process, as a second
 * Ink instance alongside the TUI's own. Returns the function that closes it.
 */
export function presentPopup(
	spec: PopupSpec,
	actions: PopupActions,
	terminal: PopupTerminal,
): () => void {
	const app = render(
		<PopupRoot
			spec={spec}
			actions={actions}
			width={terminal.output.columns}
			height={terminal.output.rows}
		/>,
		{
			stdin: createNormalizingStdin(terminal.input),
			stdout: terminal.output,
			// The TUI's own Ink instance already owns the process console.
			patchConsole: false,
		},
	);
	// Ink unmounts itself on Ctrl+C, and tmux can close the popup under it.
	// Either way the dialog went away unanswered.
	void app.waitUntilExit().then(() => {
		actions.cancel();
		terminal.close();
	});
	void terminal.closed.then(() => {
		app.unmount();
	});
	// A dialog answers from inside its own key handler, so it is unmounted only
	// once that handler has returned.
	return () => {
		queueMicrotask(() => {
			app.unmount();
		});
	};
}
