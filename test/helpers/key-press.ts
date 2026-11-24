import type {KeyPress} from '../../source/key-press.ts';

/** A key as OpenTUI's parser names it: `press('space')`, `press('g', {shift: true})`. */
export function press(
	name: string,
	modifiers: Partial<Omit<KeyPress, 'name'>> = {},
): KeyPress {
	return {name, ctrl: false, meta: false, shift: false, ...modifiers};
}
