import test from 'ava';
import {press} from '../../test/helpers/key-press.ts';
import {keysFromStdin} from '../../test/helpers/render.ts';
import type {KeyPress} from '../key-press.ts';
import {handleTextViewerKey} from './text-viewer-keys.ts';

const LINES = 50;
const VIEW = 10;

const scroll = (key: KeyPress, top: number) =>
	handleTextViewerKey(key, {top, lineCount: LINES, viewHeight: VIEW});

test('j and k move one line and stop at the top', t => {
	t.deepEqual(scroll(press('j'), 0), {action: 'scroll', top: 1});
	t.deepEqual(scroll(press('k'), 1), {action: 'scroll', top: 0});
	t.deepEqual(scroll(press('k'), 0), {action: 'scroll', top: 0});
});

test('scrolling stops once the last line reaches the bottom of the view', t => {
	t.deepEqual(scroll(press('j'), 40), {action: 'scroll', top: 40});
	t.deepEqual(scroll(press('space'), 35), {action: 'scroll', top: 40});
	t.deepEqual(scroll(press('g', {shift: true}), 0), {
		action: 'scroll',
		top: 40,
	});
});

test('a page keeps one line of overlap', t => {
	t.deepEqual(scroll(press('space'), 0), {action: 'scroll', top: 9});
	t.deepEqual(scroll(press('b'), 20), {action: 'scroll', top: 11});
	t.deepEqual(scroll(press('pagedown'), 0), {action: 'scroll', top: 9});
});

test('output shorter than the view never scrolls', t => {
	t.deepEqual(
		handleTextViewerKey(press('g', {shift: true}), {
			top: 0,
			lineCount: 3,
			viewHeight: VIEW,
		}),
		{
			action: 'scroll',
			top: 0,
		},
	);
});

test('q and Esc close', t => {
	t.deepEqual(scroll(press('q'), 5), {action: 'close'});
	t.deepEqual(scroll(press('escape'), 5), {action: 'close'});
});

test('Kitty Escape closes', async t => {
	const keys = await keysFromStdin('\x1b[27u');
	t.deepEqual(
		keys.map(key => scroll(key, 5)),
		[{action: 'close'}],
	);
});
