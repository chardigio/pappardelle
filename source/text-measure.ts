import {
	ResourceContext,
	TextBuffer,
	TextBufferView,
	type WidthMethod,
} from '@opentui/core';

// Measured with OpenTUI's own text buffer so wrap points and cell widths match
// what a <text> draws.

/** Popups only open inside tmux, where the renderer is forced to this method. */
export const POPUP_WIDTH_METHOD: WidthMethod = 'unicode';

let context: ResourceContext | undefined;
const views = new Map<
	WidthMethod,
	{buffer: TextBuffer; view: TextBufferView}
>();

function measure(
	text: string,
	widthMethod: WidthMethod,
	wrapWidth: number | null,
) {
	let entry = views.get(widthMethod);
	if (!entry) {
		context ??= new ResourceContext({objectCapacity: 8, renderCellsMax: 1});
		const buffer = TextBuffer.create(widthMethod, context);
		entry = {buffer, view: TextBufferView.create(buffer)};
		views.set(widthMethod, entry);
	}

	entry.buffer.setText(text);
	entry.view.setWrapMode(wrapWidth === null ? 'none' : 'word');
	entry.view.setWrapWidth(wrapWidth);
	return entry.view;
}

/** Rows `text` takes in a word-wrapped <text> `width` columns wide. */
export function wrappedLineCount(
	text: string,
	width: number,
	widthMethod: WidthMethod,
): number {
	return measure(text, widthMethod, Math.max(1, width)).getVirtualLineCount();
}

/** Cells OpenTUI lays `text` out in, the widest line's when it has several. */
export function displayWidth(text: string, widthMethod: WidthMethod): number {
	return measure(text, widthMethod, null).lineInfo.lineWidthColsMax;
}
