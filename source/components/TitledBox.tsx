import {
	BorderChars,
	parseColor,
	RGBA,
	type BorderStyle,
	type BoxRenderable,
	type OptimizedBuffer,
} from '@opentui/core';
import {useMemo, type ReactNode} from 'react';
import stringWidth from 'string-width';
import {terminalColor, textAttributes} from '../tui-style.ts';
import {truncateToWidth} from '../truncate-to-width.ts';

type FrameSpec = {
	title: string;
	borderColor: string;
	titleColor: string;
	style: BorderStyle;
	isDim: boolean;
};

function paintFrame(
	box: BoxRenderable,
	buffer: OptimizedBuffer,
	{title, borderColor, titleColor, style, isDim}: FrameSpec,
) {
	const chars = BorderChars[style];
	const color = parseColor(terminalColor(borderColor));
	const attributes = textAttributes({dim: isDim});
	const rule = (text: string, x: number, y: number) => {
		buffer.drawText(text, x, y, color, undefined, attributes);
	};

	const inner = Math.max(0, box.width - 2);
	const right = box.x + box.width - 1;
	const bottom = box.y + box.height - 1;
	// A trailing cell of rule keeps a full-width title reading as a frame.
	const label =
		inner >= 4 && title.length > 0
			? ` ${truncateToWidth(title, inner - 3)} `
			: '';
	const labelWidth = stringWidth(label);

	rule(chars.topLeft, box.x, box.y);
	buffer.drawText(
		label,
		box.x + 1,
		box.y,
		parseColor(terminalColor(titleColor)),
		// A transparent space would leave the native rule showing through.
		RGBA.defaultBackground(),
		textAttributes({bold: true, dim: isDim}),
	);
	rule(
		chars.horizontal.repeat(inner - labelWidth) + chars.topRight,
		box.x + 1 + labelWidth,
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

/**
 * OpenTUI's box draws its border and title without text attributes, so it can
 * neither dim an unfocused frame nor bold the heading. The box keeps its border
 * for layout, and the frame is repainted over it with the attributes. Dimming
 * goes through SGR 2 on the palette color rather than opacity: opacity blends
 * toward black, which vanishes on dark themes and darkens on light ones.
 */
export default function TitledBox({
	title,
	borderColor,
	titleColor,
	borderStyle = 'double',
	width,
	paddingY = 1,
	isDim = false,
	children,
}: {
	title: string;
	borderColor: string;
	titleColor: string;
	borderStyle?: 'double' | 'round';
	width: number;
	paddingY?: number;
	isDim?: boolean;
	children: ReactNode;
}) {
	const style = borderStyle === 'round' ? 'rounded' : borderStyle;
	const renderAfter = useMemo(() => {
		const spec: FrameSpec = {title, borderColor, titleColor, style, isDim};
		return function (this: BoxRenderable, buffer: OptimizedBuffer) {
			paintFrame(this, buffer, spec);
		};
	}, [title, borderColor, titleColor, style, isDim]);

	return (
		<box
			flexDirection="column"
			width={width}
			border
			borderStyle={style}
			borderColor={terminalColor(borderColor)}
			renderAfter={renderAfter}
			paddingX={2}
			paddingY={paddingY}
		>
			{children}
		</box>
	);
}
