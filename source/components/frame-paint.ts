import {
	BorderChars,
	parseColor,
	RGBA,
	type BorderStyle,
	type BoxRenderable,
	type OptimizedBuffer,
} from '@opentui/core';
import {
	combineAttributes,
	terminalColor,
	textAttributes,
} from '../tui-style.ts';
import {displayWidth} from '../text-measure.ts';
import {truncateRunsToWidth} from '../truncate-to-width.ts';
import type {Run} from './TruncatedLine.tsx';

export type FrameSpec = {
	/** A plain title is bold in `titleColor`; runs keep their own styles. */
	title: string | readonly Run[];
	/** Dim text at the right end of the top rule, dropped first when narrow. */
	trailing?: string;
	borderColor?: string;
	titleColor?: string;
	style: BorderStyle;
	isDim: boolean;
	/** Rule cells between the corner and the title. */
	inset?: number;
};

// The narrowest a title gets before the frame drops it, or drops the trailing
// label to keep it.
const MIN_TITLE_CELLS = 4;
// The spaces either side of a title, and the rule cell after it.
const LABEL_PADDING_CELLS = 3;

function ruleDrawer(
	buffer: OptimizedBuffer,
	{borderColor, isDim}: Pick<FrameSpec, 'borderColor' | 'isDim'>,
) {
	const color = parseColor(terminalColor(borderColor));
	const attributes = textAttributes({dim: isDim});
	return (text: string, x: number, y: number) => {
		buffer.drawText(text, x, y, color, undefined, attributes);
	};
}

export function paintFrame(
	box: Pick<BoxRenderable, 'x' | 'y' | 'width' | 'height'>,
	buffer: OptimizedBuffer,
	{
		title,
		trailing,
		borderColor,
		titleColor,
		style,
		isDim,
		inset = 0,
	}: FrameSpec,
) {
	const chars = BorderChars[style];
	const rule = ruleDrawer(buffer, {borderColor, isDim});
	const {widthMethod} = buffer;

	const inner = Math.max(0, box.width - 2);
	const right = box.x + box.width - 1;
	const bottom = box.y + box.height - 1;
	const lead = Math.min(inset, Math.max(0, inner - MIN_TITLE_CELLS));
	const runs: readonly Run[] =
		typeof title === 'string'
			? [
					{
						text: title,
						fg: terminalColor(titleColor),
						attributes: textAttributes({bold: true}),
					},
				]
			: title;
	const titleCells = runs.reduce(
		(sum, run) => sum + displayWidth(run.text, widthMethod),
		0,
	);

	// The trailing label and the rule cell after it, kept only while the title
	// still shows at least a few cells beside it.
	const trailingLabel = trailing ? ` ${trailing} ` : '';
	const trailingCells = trailingLabel
		? displayWidth(trailingLabel, widthMethod) + 1
		: 0;
	const keepsTrailing =
		trailingCells > 0 &&
		inner - lead - trailingCells - LABEL_PADDING_CELLS >=
			Math.min(titleCells, MIN_TITLE_CELLS);
	const titleSpace = inner - lead - (keepsTrailing ? trailingCells : 0);

	// A trailing cell of rule keeps a full-width title reading as a frame.
	const shown =
		titleSpace >= MIN_TITLE_CELLS && titleCells > 0
			? truncateRunsToWidth(
					[...runs],
					titleSpace - LABEL_PADDING_CELLS,
					widthMethod,
				)
			: [];
	const labelWidth =
		shown.length > 0
			? shown.reduce((sum, run) => sum + displayWidth(run.text, widthMethod), 2)
			: 0;

	rule(chars.topLeft + chars.horizontal.repeat(lead), box.x, box.y);
	if (shown.length > 0) {
		const frameAttributes = textAttributes({dim: isDim});
		// A transparent space would leave the native rule showing through.
		const background = RGBA.defaultBackground();
		let x = box.x + 1 + lead;
		const drawLabelText = (text: string, run?: Run) => {
			buffer.drawText(
				text,
				x,
				box.y,
				parseColor(run?.fg ?? terminalColor(titleColor)),
				background,
				combineAttributes(frameAttributes, run?.attributes),
			);
			x += displayWidth(text, widthMethod);
		};

		drawLabelText(' ');
		for (const run of shown) drawLabelText(run.text, run);
		drawLabelText(' ');
	}

	const fill = inner - lead - labelWidth - (keepsTrailing ? trailingCells : 0);
	rule(chars.horizontal.repeat(fill), box.x + 1 + lead + labelWidth, box.y);
	if (keepsTrailing) {
		const trailingX = right - trailingCells;
		buffer.drawText(
			trailingLabel,
			trailingX,
			box.y,
			parseColor(terminalColor()),
			RGBA.defaultBackground(),
			textAttributes({dim: true}),
		);
		rule(chars.horizontal, right - 1, box.y);
	}

	rule(chars.topRight, right, box.y);
	for (let y = box.y + 1; y < bottom; y++) {
		rule(chars.vertical, box.x, y);
		rule(chars.vertical, right, y);
	}

	rule(
		chars.bottomLeft + chars.horizontal.repeat(inner) + chars.bottomRight,
		box.x,
		bottom,
	);
}
