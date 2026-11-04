import {useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {
	type InputRenderable,
	type InputKeyBinding,
	type KeyEvent,
	type TextareaRenderable,
	SyntaxStyle,
	RGBA,
} from '@opentui/core';
import {useKeyboard, useRenderer} from '@opentui/react';
import {terminalColor} from '../tui-style.ts';

const maxPromptRows = 10;

export type InputHighlight = {
	length: number;
	color: 'cyan' | 'green' | 'magenta';
};

const keyBindings: InputKeyBinding[] = [
	{name: 'a', ctrl: true, action: 'line-home'},
	{name: 'e', ctrl: true, action: 'line-end'},
	{name: 'u', ctrl: true, action: 'delete-to-line-start'},
	{name: 'left', meta: true, action: 'word-backward'},
	{name: 'right', meta: true, action: 'word-forward'},
	{name: 'b', meta: true, action: 'word-backward'},
	{name: 'f', meta: true, action: 'word-forward'},
	{name: 'backspace', meta: true, action: 'delete-word-backward'},
	// Readline's undo; Ctrl+- reaches us as Ctrl+_ without the kitty protocol.
	{name: '_', ctrl: true, action: 'undo'},
];
const multilineKeyBindings: InputKeyBinding[] = [
	...keyBindings,
	{name: 'return', action: 'submit'},
];

type Props = {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	placeholder?: string;
	isFocused?: boolean;
	isShowingCursor?: boolean;
	highlight?: InputHighlight;
	isMultiline?: boolean;
};

/** Native editing supplies paste buffering, Unicode cursor movement and scrolling.
 * The suggestion picker can own navigation while Enter still submits the field.
 */
export default function TextInput({
	value,
	onChange,
	onSubmit,
	placeholder = '',
	isFocused = true,
	isShowingCursor = true,
	highlight,
	isMultiline = false,
}: Props) {
	const renderer = useRenderer();
	const ref = useRef<InputRenderable | TextareaRenderable>(null);
	const syntaxStyle = useMemo(
		() =>
			SyntaxStyle.fromStyles(
				{
					cyan: {fg: terminalColor('cyan')},
					green: {fg: terminalColor('green')},
					magenta: {fg: terminalColor('magenta')},
				},
				renderer.nativeScene!,
			),
		[renderer],
	);
	useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);
	useLayoutEffect(() => {
		const input = ref.current;
		if (!input) return;
		if (isMultiline && input.plainText !== value) {
			input.setText(value);
			input.gotoBufferEnd();
		}
		input.clearAllHighlights();
		if (highlight && highlight.length > 0) {
			input.addHighlightByCharRange({
				start: 0,
				end: highlight.length,
				styleId: syntaxStyle.getStyleId(highlight.color)!,
			});
		}
	}, [value, highlight, syntaxStyle, isMultiline]);
	useKeyboard(key => {
		if (isFocused && !isShowingCursor && key.name === 'return')
			onSubmit?.(value);
	});
	const common = useMemo(
		() => ({
			flexGrow: 1,
			flexShrink: 1,
			minWidth: 1,
			focused: isFocused && isShowingCursor,
			showCursor: isShowingCursor,
			backgroundColor: 'transparent',
			focusedBackgroundColor: 'transparent',
			textColor: RGBA.defaultForeground(),
			focusedTextColor: RGBA.defaultForeground(),
			placeholderColor: terminalColor('gray'),
			placeholder,
			cursorStyle: {style: 'block' as const, blinking: false},
			selectionBg: terminalColor('cyan'),
			selectionFg: terminalColor('black'),
			syntaxStyle,
		}),
		[isFocused, isShowingCursor, placeholder, syntaxStyle],
	);
	const onKeyDown = (key: KeyEvent) => {
		// These belong to the parent suggestion picker; do not move the input caret.
		if (['up', 'down', 'tab', 'escape'].includes(key.name))
			key.preventDefault();
	};
	const submit = () => onSubmit?.(ref.current?.plainText ?? value);
	if (isMultiline)
		return (
			<textarea
				{...common}
				ref={node => {
					ref.current = node;
				}}
				initialValue={value}
				minHeight={1}
				maxHeight={maxPromptRows}
				wrapMode="word"
				keyBindings={multilineKeyBindings}
				onKeyDown={onKeyDown}
				onSubmit={submit}
				onContentChange={() => onChange(ref.current?.plainText ?? value)}
			/>
		);
	return (
		<input
			{...common}
			ref={node => {
				ref.current = node;
			}}
			value={value}
			keyBindings={keyBindings}
			onKeyDown={onKeyDown}
			onInput={onChange}
			onSubmit={submit}
		/>
	);
}
