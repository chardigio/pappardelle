/** An empty configured emoji reserves a slot; undefined removes it entirely. */
export function resolveEmojiSlot(
	rawEmoji: string | undefined,
): {text: string; needsSeparator: boolean} | null {
	if (rawEmoji === undefined) return null;
	return {text: rawEmoji === '' ? '  ' : rawEmoji, needsSeparator: true};
}
