import widestLine from 'widest-line';
import {
	buildHelpLines,
	buildHelpRows,
	helpFooter,
	HELP_CHROME_ROWS,
} from '../components/help-rows.ts';
import {formatVersionLine} from '../help-version-line.ts';
import {closeSpaceContent} from '../close-state-choice.ts';
import {agentPickerHeight, agentPickerWidth} from '../agent-profile-picker.ts';
import {wrappedLineCount} from '../text-measure.ts';
import type {ConfirmPopupProps, PopupSpec} from './spec.ts';

export type ClientSize = {cols: number; rows: number};
export type PopupSize = {width: number; height: number};

const CONFIRM_MAX_WIDTH = 72;
// Border (1 each side) plus paddingX={2} on the dialog Box.
const HORIZONTAL_CHROME = 6;
// Border (1 each side) plus paddingY={1}.
const VERTICAL_CHROME = 4;
const CONFIRM_HINT = 'Press y or Enter to confirm, n or Esc to cancel';
const CLOSE_SPACE_HINT = '←/→ change state · y/Enter confirm · n/Esc cancel';

// tmux refuses a popup as tall as the client when a status line is on.
const STATUS_LINE_ROWS = 2;

function clamp(size: PopupSize, client: ClientSize): PopupSize {
	return {
		width: Math.max(1, Math.min(size.width, client.cols)),
		height: Math.max(1, Math.min(size.height, client.rows - STATUS_LINE_ROWS)),
	};
}

function fraction(client: ClientSize): PopupSize {
	return {
		width: Math.floor(client.cols * 0.8),
		height: Math.floor(client.rows * 0.8),
	};
}

// Popups only open inside tmux, where the renderer is forced to this method.
const POPUP_WIDTH_METHOD = 'unicode';

function lines(text: string, inner: number): number {
	return wrappedLineCount(text, inner, POPUP_WIDTH_METHOD);
}

function confirmHeight(
	{title, message, detail}: ConfirmPopupProps,
	inner: number,
	hint: string,
): number {
	return (
		VERTICAL_CHROME +
		lines(title, inner) +
		1 +
		lines(message, inner) +
		1 +
		(detail ? lines(detail, inner) + 1 : 0) +
		lines(hint, inner)
	);
}

export function popupSize(spec: PopupSpec, client: ClientSize): PopupSize {
	switch (spec.kind) {
		case 'confirm': {
			const width = Math.min(CONFIRM_MAX_WIDTH, client.cols - 4);
			const inner = width - HORIZONTAL_CHROME;
			const height = confirmHeight(spec.props, inner, CONFIRM_HINT);
			return clamp({width, height}, client);
		}

		case 'close-space': {
			const width = Math.min(CONFIRM_MAX_WIDTH, client.cols - 4);
			const inner = width - HORIZONTAL_CHROME;
			const content = closeSpaceContent(spec.props.spaceName);
			// The tracker's ability to pick a state is only known inside the
			// popup, so it is sized for the state row and its margin either way.
			const height =
				confirmHeight(content, inner, CLOSE_SPACE_HINT) +
				// The state row is truncated to one line, plus its margin.
				2;
			return clamp({width, height}, client);
		}

		case 'help': {
			const {customKeybindings, commitSha, installedVersion, isDevBuild} =
				spec.props;
			const rows = buildHelpRows(customKeybindings);
			const shortcutRows = [...rows.fixed, ...rows.overridable];
			const customRows = rows.extraCustom;
			const rowWidth = Math.max(
				...[...shortcutRows, ...customRows].map(
					row => rows.maxKeyLength + 1 + widestLine(row.description),
				),
			);
			const lines = buildHelpLines(rows);
			const height = HELP_CHROME_ROWS + lines.length;
			const maxHeight = client.rows - STATUS_LINE_ROWS;
			const contentWidth = Math.max(
				rowWidth,
				...lines.map(line =>
					line.kind === 'heading' ? widestLine(line.text) : 0,
				),
				widestLine(formatVersionLine(installedVersion, commitSha, isDevBuild)),
				widestLine(helpFooter(height > maxHeight)),
			);
			return clamp({width: contentWidth + HORIZONTAL_CHROME, height}, client);
		}

		case 'agent-profile': {
			return clamp(
				{
					width: agentPickerWidth(client.cols),
					height: agentPickerHeight(spec.props.options.length),
				},
				client,
			);
		}

		case 'errors':
		case 'issue': {
			return clamp(fraction(client), client);
		}
	}
}
