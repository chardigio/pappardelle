import widestLine from 'widest-line';
import {buildHelpRows} from '../components/help-rows.ts';
import {MAX_VISIBLE_SUGGESTIONS} from '../components/ready-picker.ts';
import {PICKER_MAX_VISIBLE} from '../profile-picker.ts';
import {SKILL_PICKER_MAX_VISIBLE} from '../skill-completion.ts';
import {formatVersionLine} from '../help-version-line.ts';
import type {PopupSpec} from './protocol.ts';

export type ClientSize = {cols: number; rows: number};
export type PopupSize = {width: number; height: number};

const CONFIRM_MAX_WIDTH = 72;
// Border (1 each side) plus paddingX={2} on the dialog Box.
const HORIZONTAL_CHROME = 6;
// Border (1 each side) plus paddingY={1}.
const VERTICAL_CHROME = 4;
const CONFIRM_HINT = 'Press y or Enter to confirm, n or Esc to cancel';
const HELP_FOOTER = 'Press Esc, Enter, or ? to close';

// The tallest the new-session dialog gets. tmux can't resize an open popup,
// so it is sized for the worst case: the prompt box, a full ready list with
// scroll markers and its hint, the taller of the two pickers with markers and
// hint, and an error line.
const PROMPT_BOX_ROWS = 11;
const LIST_CHROME_ROWS = 2 + 2 + 1;
const PROMPT_MAX_ROWS =
	PROMPT_BOX_ROWS +
	MAX_VISIBLE_SUGGESTIONS +
	LIST_CHROME_ROWS +
	Math.max(PICKER_MAX_VISIBLE, SKILL_PICKER_MAX_VISIBLE) +
	LIST_CHROME_ROWS +
	2;

/**
 * Rows a string takes once Ink word-wraps it at `width` columns. Words longer
 * than the line are split, which is what Ink's hard wrap does too.
 */
export function wrappedLineCount(text: string, width: number): number {
	if (width <= 0) return 1;
	let lines = 0;
	for (const paragraph of text.split('\n')) {
		let current = 0;
		lines++;
		for (const word of paragraph.split(' ')) {
			let wordWidth = widestLine(word);
			const needed = current === 0 ? wordWidth : current + 1 + wordWidth;
			if (needed <= width) {
				current = needed;
				continue;
			}

			if (current > 0) lines++;
			while (wordWidth > width) {
				wordWidth -= width;
				lines++;
			}

			current = wordWidth;
		}
	}

	return lines;
}

function clamp(size: PopupSize, client: ClientSize): PopupSize {
	return {
		width: Math.max(1, Math.min(size.width, client.cols)),
		height: Math.max(1, Math.min(size.height, client.rows)),
	};
}

function fraction(client: ClientSize): PopupSize {
	return {
		width: Math.floor(client.cols * 0.8),
		height: Math.floor(client.rows * 0.8),
	};
}

export function popupSize(spec: PopupSpec, client: ClientSize): PopupSize {
	switch (spec.kind) {
		case 'confirm': {
			const width = Math.min(CONFIRM_MAX_WIDTH, client.cols - 4);
			const inner = width - HORIZONTAL_CHROME;
			const {title, message, detail} = spec.props;
			const height =
				VERTICAL_CHROME +
				wrappedLineCount(title, inner) +
				1 +
				wrappedLineCount(message, inner) +
				1 +
				(detail ? wrappedLineCount(detail, inner) + 1 : 0) +
				wrappedLineCount(CONFIRM_HINT, inner);
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
			const contentWidth = Math.max(
				rowWidth,
				widestLine(formatVersionLine(installedVersion, commitSha, isDevBuild)),
				widestLine(HELP_FOOTER),
			);
			const height =
				VERTICAL_CHROME +
				// Title and version line, then a margin.
				3 +
				shortcutRows.length +
				// "Custom Commands" heading with a margin on each side.
				(customRows.length > 0 ? customRows.length + 3 : 0) +
				// Margin, then the footer.
				2;
			return clamp(
				{width: contentWidth + HORIZONTAL_CHROME, height},
				{cols: client.cols, rows: client.rows - 2},
			);
		}

		case 'prompt': {
			return clamp(
				{
					width: fraction(client).width,
					height: Math.min(PROMPT_MAX_ROWS, client.rows - 2),
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
