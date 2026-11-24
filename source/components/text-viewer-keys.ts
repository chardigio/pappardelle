import {typedText, type KeyPress} from '../key-press.ts';

export type ScrollAction = {action: 'scroll'; top: number} | {action: 'close'};

/**
 * Map a keystroke to the viewer's next scroll offset. `top` is the first
 * visible line; it never goes past the point where the last line sits at the
 * bottom of the view, so paging to the end leaves a full screen of text.
 */
export function handleTextViewerKey(
	key: KeyPress,
	{
		top,
		lineCount,
		viewHeight,
	}: {top: number; lineCount: number; viewHeight: number},
): ScrollAction {
	const input = typedText(key);
	if (key.name === 'escape' || input === 'q') return {action: 'close'};

	const maxTop = Math.max(0, lineCount - viewHeight);
	const page = Math.max(1, viewHeight - 1);
	const to = (next: number): ScrollAction => ({
		action: 'scroll',
		top: Math.min(maxTop, Math.max(0, next)),
	});

	if (key.name === 'down' || input === 'j') return to(top + 1);
	if (key.name === 'up' || input === 'k') return to(top - 1);
	if (key.name === 'pagedown' || input === ' ' || input === 'f')
		return to(top + page);
	if (key.name === 'pageup' || input === 'b') return to(top - page);
	if (input === 'g') return to(0);
	if (input === 'G') return to(maxTop);
	return to(top);
}
