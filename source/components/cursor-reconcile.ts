/**
 * Where the caret belongs after the parent hands `TextInput` a new value.
 *
 * `TextInput` owns its cursor, so a value the *parent* replaces wholesale
 * (accepting a slash-command completion, clearing the field) used to leave the
 * caret wherever the last keystroke put it. Completing `/do-pap` into
 * `/do-pappardelle ` stranded it after the seventh character, so the next thing
 * typed landed in the middle of the skill name.
 *
 * Telling the two apart needs one piece of memory: the value the input last
 * emitted. An incoming value equal to that is the parent echoing back the
 * input's own keystroke, and the caret is already correct. Anything else came
 * from outside, and the end of the new text is the only position that makes
 * sense to keep typing from.
 */
export function reconcileCursorOffset(opts: {
	incomingValue: string;
	lastEmittedValue: string;
	cursorOffset: number;
}): number {
	const {incomingValue, lastEmittedValue, cursorOffset} = opts;
	if (incomingValue !== lastEmittedValue) {
		return incomingValue.length;
	}

	// The caret may rest one past the last character, so `length` is in range.
	return Math.max(0, Math.min(cursorOffset, incomingValue.length));
}
