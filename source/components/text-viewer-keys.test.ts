import {test, expect} from 'bun:test';
import {press} from '../../test/helpers/key-press.ts';
import {keysFromStdin} from '../../test/helpers/render.ts';
import type {KeyPress} from '../key-press.ts';
import {handleTextViewerKey} from './text-viewer-keys.ts';

const LINES = 50;
const VIEW = 10;

const scroll = (key: KeyPress, top: number) =>
	handleTextViewerKey(key, {top, lineCount: LINES, viewHeight: VIEW});

test('j and k move one line and stop at the top', () => {
	expect(scroll(press('j'), 0)).toStrictEqual({action: 'scroll', top: 1});
	expect(scroll(press('k'), 1)).toStrictEqual({action: 'scroll', top: 0});
	expect(scroll(press('k'), 0)).toStrictEqual({action: 'scroll', top: 0});
});

test('scrolling stops once the last line reaches the bottom of the view', () => {
	expect(scroll(press('j'), 40)).toStrictEqual({action: 'scroll', top: 40});
	expect(scroll(press('space'), 35)).toStrictEqual({action: 'scroll', top: 40});
	expect(scroll(press('g', {shift: true}), 0)).toStrictEqual({
		action: 'scroll',
		top: 40,
	});
});

test('a page keeps one line of overlap', () => {
	expect(scroll(press('space'), 0)).toStrictEqual({action: 'scroll', top: 9});
	expect(scroll(press('b'), 20)).toStrictEqual({action: 'scroll', top: 11});
	expect(scroll(press('pagedown'), 0)).toStrictEqual({
		action: 'scroll',
		top: 9,
	});
});

test('output shorter than the view never scrolls', () => {
	expect(
		handleTextViewerKey(press('g', {shift: true}), {
			top: 0,
			lineCount: 3,
			viewHeight: VIEW,
		}),
	).toStrictEqual({
		action: 'scroll',
		top: 0,
	});
});

test('q and Esc close', () => {
	expect(scroll(press('q'), 5)).toStrictEqual({action: 'close'});
	expect(scroll(press('escape'), 5)).toStrictEqual({action: 'close'});
});

test('Kitty Escape closes', async () => {
	const keys = await keysFromStdin('\x1b[27u');
	expect(keys.map(key => scroll(key, 5))).toStrictEqual([{action: 'close'}]);
});
