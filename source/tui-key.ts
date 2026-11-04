import type {KeyEvent} from '@opentui/core';

/** Adapt framework events to the application's independently tested keymaps.
 * OpenTUI owns byte parsing, Kitty keys, repeat/release handling and paste.
 */
export function shortcutKey(event: KeyEvent) {
	const {name, ctrl, meta, shift, option} = event;
	const printable = name === 'space' ? ' ' : [...name].length === 1 ? name : '';
	return {
		input: shift ? printable.toUpperCase() : printable,
		key: {
			ctrl,
			meta: meta || option,
			shift,
			upArrow: name === 'up',
			downArrow: name === 'down',
			leftArrow: name === 'left',
			rightArrow: name === 'right',
			pageUp: name === 'pageup',
			pageDown: name === 'pagedown',
			home: name === 'home',
			end: name === 'end',
			return: name === 'return' || name === 'enter',
			escape: name === 'escape',
			tab: name === 'tab',
			backspace: name === 'backspace',
			delete: name === 'delete',
		},
	};
}
