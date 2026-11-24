import type {KeyEvent} from '@opentui/core';

/** The fields the keymaps read; a KeyEvent satisfies it. */
export type KeyPress = Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift'>;

/** The key's typed text. */
export function typedText({name, ctrl, meta, shift}: KeyPress): string {
	// Ctrl+Q is not `q`: a letter held with Ctrl or Alt types nothing, so it
	// reaches no single-letter shortcut. OpenTUI sets meta for Alt and Option.
	if (ctrl || meta) return '';
	const typed = name === 'space' ? ' ' : [...name].length === 1 ? name : '';
	return shift ? typed.toUpperCase() : typed;
}
