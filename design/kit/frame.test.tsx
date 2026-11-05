import test from 'ava';
import {terminalColor, textAttributes} from '../../source/tui-style.ts';
import {
	cells,
	diffFrames,
	fromAnsi,
	isBlankLine,
	renderFrame,
} from './frame.ts';

const sample = (
	<box flexDirection="column">
		<text wrapMode="none">
			<span fg={terminalColor('red')}>ab</span>
			<span fg={terminalColor()}>c</span>
			<span fg={terminalColor('#de7356')}>d</span>
		</text>
		<text
			wrapMode="none"
			fg={terminalColor('blue')}
			attributes={textAttributes({inverse: true, dim: true})}
		>
			🎨x
		</text>
	</box>
);

test('palette slots, the default color and RGB keep their identity', async t => {
	const frame = await renderFrame(sample, 6, 2);
	t.deepEqual(frame.lines[0]!.slice(0, 3), [
		['ab', 1, 'd', 0, 2],
		['c', 'd', 'd', 0, 1],
		['d', '#de7356', 'd', 0, 1],
	]);
});

test('attributes survive capture and wide graphemes get their own span', async t => {
	const frame = await renderFrame(sample, 6, 2);
	const inverseDim = textAttributes({inverse: true, dim: true});
	t.deepEqual(frame.lines[1]!.slice(0, 2), [
		['🎨', 4, 4, inverseDim, 2],
		['x', 4, 4, inverseDim, 1],
	]);
});

test('a tmux capture of the same cells parses to the same frame', async t => {
	const offscreen = await renderFrame(sample, 6, 2);
	// tmux only writes SGR on style changes, so line two inherits nothing here
	// but must still reset correctly, and RGB uses the colon form.
	const captured =
		'\u001B[38;5;1mab\u001B[39mc\u001B[38:2::222:115:86md\u001B[0m\n' +
		'\u001B[2;7m\u001B[38;5;4m\u001B[48;5;4m🎨x\u001B[0m';
	t.deepEqual(diffFrames(offscreen, fromAnsi(captured, 6, 2)), []);
});

test('style carries across lines when tmux omits a repeated SGR', t => {
	const frame = fromAnsi('\u001B[38;5;1m║ \n║', 2, 2);
	t.deepEqual(frame.lines[1]![0], ['║', 1, 'd', 0, 1]);
});

/** [fg, bg, attributes] of the last cell of a one-row capture. */
function lastStyle(ansi: string) {
	const cell = cells(fromAnsi(ansi, 8, 1))[0]!.at(-1)!;
	return [cell.fg, cell.bg, cell.attrs];
}

test('SGR 0 resets colors and every attribute', t => {
	t.deepEqual(lastStyle('\u001B[1;2;3;4;7;9;31;42ma\u001B[0mb'), ['d', 'd', 0]);
});

test('each SGR off code clears only its own attributes', t => {
	const style = textAttributes;
	t.deepEqual(lastStyle('\u001B[1;2;3ma\u001B[22mb'), [
		'd',
		'd',
		style({italic: true}),
	]);
	t.deepEqual(lastStyle('\u001B[7;1ma\u001B[27mb'), [
		'd',
		'd',
		style({bold: true}),
	]);
	t.deepEqual(lastStyle('\u001B[4;9ma\u001B[24mb'), [
		'd',
		'd',
		style({strikethrough: true}),
	]);
});

test('bright colors are palette slots 8 to 15', t => {
	t.deepEqual(lastStyle('\u001B[91;102mx'), [9, 10, 0]);
	t.deepEqual(lastStyle('\u001B[97;100mx'), [15, 8, 0]);
});

test('colon sub-parameters keep their meaning', t => {
	const underline = textAttributes({underline: true});
	t.deepEqual(lastStyle('\u001B[4:3mx'), ['d', 'd', underline], 'curly');
	t.deepEqual(lastStyle('\u001B[4m\u001B[4:0mx'), ['d', 'd', 0], 'none');
	t.deepEqual(
		lastStyle('\u001B[38:2:1:10:20:30mx'),
		['#0a141e', 'd', 0],
		'with a color-space id',
	);
	t.deepEqual(lastStyle('\u001B[38:2:10:20:30mx'), ['#0a141e', 'd', 0]);
	t.deepEqual(lastStyle('\u001B[48:5:9mx'), ['d', 9, 0]);
});

test('underline color is skipped with its parameters', t => {
	t.deepEqual(lastStyle('\u001B[58;2;1;2;3mx'), ['d', 'd', 0]);
	t.deepEqual(lastStyle('\u001B[58;5;9;31mx'), [1, 'd', 0]);
	t.deepEqual(lastStyle('\u001B[58:2::1:2:3;31mx'), [1, 'd', 0]);
	t.deepEqual(lastStyle('\u001B[1;59mx'), [
		'd',
		'd',
		textAttributes({bold: true}),
	]);
});

test('text past the frame width is cropped', t => {
	t.deepEqual(fromAnsi('abcdef', 3, 1).lines[0], [['abc', 'd', 'd', 0, 3]]);
});

test('a wide grapheme that does not fit ends the row', t => {
	t.deepEqual(fromAnsi('abcd🎨ef', 5, 1).lines[0], [['abcd', 'd', 'd', 0, 4]]);
});

test('styles past the crop edge still carry to the next row', t => {
	const frame = fromAnsi('abc\u001B[31mdef\nx', 2, 2);
	t.deepEqual(frame.lines[1], [['x', 1, 'd', 0, 1]]);
});

test('a tab advances to the next multiple of 8 columns', t => {
	const row = cells(fromAnsi('ab\tc\td', 12, 1))[0]!;
	t.is(row.map(cell => cell.char).join(''), 'ab      c   ');
});

test('OSC hyperlinks are not text', t => {
	const link = (end: string) =>
		`\u001B]8;;https://example.com${end}link\u001B]8;;${end}!`;
	t.deepEqual(fromAnsi(link('\u001B\\'), 8, 1).lines[0], [
		['link!', 'd', 'd', 0, 5],
	]);
	t.deepEqual(fromAnsi(link('\u0007'), 8, 1).lines[0], [
		['link!', 'd', 'd', 0, 5],
	]);
});

test('a space counts as blank only when it draws nothing', t => {
	const empty = fromAnsi('', 2, 1);
	for (const sgr of ['4', '9', '7', '41'])
		t.is(
			diffFrames(fromAnsi(`\u001B[${sgr}m `, 2, 1), empty).length,
			1,
			`SGR ${sgr}`,
		);
	t.deepEqual(diffFrames(fromAnsi('\u001B[1;3m ', 2, 1), empty), []);
	t.false(isBlankLine(fromAnsi('\u001B[4m ', 2, 1).lines[0]!));
	t.true(isBlankLine(fromAnsi('\u001B[1m ', 2, 1).lines[0]!));
});
