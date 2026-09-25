/** Removes Fitzpatrick skin-tone modifiers (U+1F3FB to U+1F3FF). */
export function stripSkinTones(text: string): string {
	return text.replaceAll(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** An empty configured emoji reserves a slot; undefined removes it entirely. */
export function resolveEmojiSlot(
	rawEmoji: string | undefined,
): {text: string; needsSeparator: boolean} | null {
	if (rawEmoji === undefined) return null;
	return {text: rawEmoji === '' ? '  ' : rawEmoji, needsSeparator: true};
}
