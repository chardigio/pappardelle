import type {CliRenderer} from '@opentui/core';
import {renderTui} from '../render-tui.ts';
import PopupRoot from '../components/PopupRoot.tsx';
import type {PopupActions, PopupSpec} from './spec.ts';
import type {PopupTerminal} from './terminal.ts';

// The popup's PTY counts as remote to OpenTUI, which then forwards no
// environment; without TERM and COLORTERM it converts palette colors to RGB.
const popupEnvKeys = [
	'TERM',
	'COLORTERM',
	'TERM_PROGRAM',
	'TERM_PROGRAM_VERSION',
	'TMUX',
];

/** Render into the popup PTY, with an independent OpenTUI renderer. */
export function presentPopup(
	spec: PopupSpec,
	actions: PopupActions,
	terminal: PopupTerminal,
): () => void {
	let renderer: CliRenderer | undefined;
	let closing = false;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		actions.cancel();
		terminal.close();
	};
	const close = () => {
		closing = true;
		terminal.dismiss();
		// Answers originate in key handlers. Defer teardown until dispatch ends.
		queueMicrotask(() => renderer?.destroy());
	};
	// Once tmux has torn the popup's tty down, OpenTUI's raw-mode reset on it
	// throws, and the logged throw would show in the rail's error count.
	let ttyGone = false;
	const {input} = terminal;
	const setRawMode = input.setRawMode.bind(input);
	input.setRawMode = mode => (ttyGone ? input : setRawMode(mode));
	input.once('close', () => {
		ttyGone = true;
	});
	void terminal.closed.then(() => {
		ttyGone = true;
		close();
	});
	void renderTui(
		<PopupRoot
			spec={spec}
			actions={actions}
			width={terminal.output.columns}
			height={terminal.output.rows}
		/>,
		{
			stdin: terminal.input,
			stdout: terminal.output,
			forwardEnvKeys: popupEnvKeys,
			// Ctrl+C destroys only this renderer; it does not exit the rail process.
			exitOnCtrlC: true,
			exitSignals: [],
			useMouse: false,
		},
	)
		.then(view => {
			renderer = view.renderer;
			void renderer.closed.catch(finish).then(finish);
			if (closing) renderer.destroy();
		})
		.catch(finish);
	return close;
}
