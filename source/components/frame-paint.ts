import {
	BorderChars,
	parseColor,
	RGBA,
	type BorderStyle,
	type BoxRenderable,
	type OptimizedBuffer,
} from '@opentui/core';
import {terminalColor, textAttributes} from '../tui-style.ts';
import {displayWidth} from '../text-measure.ts';
import {truncateToWidth} from '../truncate-to-width.ts';

export type FrameSpec = {
	title: string;
	borderColor?: string;
	titleColor?: string;
	style: BorderStyle;
	isDim: boolean;
	/** Rule cells between the corner and the title. */
	inset?: number;
};

type RuleSpec = Pick<FrameSpec, 'borderColor' | 'style' | 'isDim'>;

function ruleDrawer(
	buffer: OptimizedBuffer,
	{borderColor, isDim}: Pick<RuleSpec, 'borderColor' | 'isDim'>,
) {
	const color = parseColor(terminalColor(borderColor));
	const attributes = textAttributes({dim: isDim});
	return (text: string, x: number, y: number) => {
		buffer.drawText(text, x, y, color, undefined, attributes);
	};
}

/**
 * A horizontal rule across a frame's content row, teed into the frame's
 * sides: `row` is the content box, one cell inside each side.
 */
export function paintFrameRule(
	row: Pick<BoxRenderable, 'x' | 'y' | 'width'>,
	buffer: OptimizedBuffer,
	{borderColor, style, isDim}: RuleSpec,
) {
	const chars = BorderChars[style];
	ruleDrawer(buffer, {borderColor, isDim})(
		chars.leftT + chars.horizontal.repeat(row.width) + chars.rightT,
		row.x - 1,
		row.y,
	);
}

export function paintFrame(
	box: Pick<BoxRenderable, 'x' | 'y' | 'width' | 'height'>,
	buffer: OptimizedBuffer,
	{title, borderColor, titleColor, style, isDim, inset = 0}: FrameSpec,
) {
	const chars = BorderChars[style];
	const rule = ruleDrawer(buffer, {borderColor, isDim});

	const inner = Math.max(0, box.width - 2);
	const right = box.x + box.width - 1;
	const bottom = box.y + box.height - 1;
	const lead = Math.min(inset, Math.max(0, inner - 4));
	// A trailing cell of rule keeps a full-width title reading as a frame.
	const label =
		inner - lead >= 4 && title.length > 0
			? ` ${truncateToWidth(title, inner - lead - 3, buffer.widthMethod)} `
			: '';
	const labelWidth = displayWidth(label, buffer.widthMethod);

	rule(chars.topLeft + chars.horizontal.repeat(lead), box.x, box.y);
	buffer.drawText(
		label,
		box.x + 1 + lead,
		box.y,
		parseColor(terminalColor(titleColor)),
		// A transparent space would leave the native rule showing through.
		RGBA.defaultBackground(),
		textAttributes({bold: true, dim: isDim}),
	);
	rule(
		chars.horizontal.repeat(inner - lead - labelWidth) + chars.topRight,
		box.x + 1 + lead + labelWidth,
		box.y,
	);
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
