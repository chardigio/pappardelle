import test from 'ava';
import {handleTextViewerKey} from './text-viewer-keys.ts';

const LINES = 50;
const VIEW = 10;

const press = (input: string, top: number, key = {}) =>
	handleTextViewerKey(input, key, {top, lineCount: LINES, viewHeight: VIEW});

test('j and k move one line and stop at the top', t => {
	t.deepEqual(press('j', 0), {action: 'scroll', top: 1});
	t.deepEqual(press('k', 1), {action: 'scroll', top: 0});
	t.deepEqual(press('k', 0), {action: 'scroll', top: 0});
});

test('scrolling stops once the last line reaches the bottom of the view', t => {
	t.deepEqual(press('j', 40), {action: 'scroll', top: 40});
	t.deepEqual(press(' ', 35), {action: 'scroll', top: 40});
	t.deepEqual(press('G', 0), {action: 'scroll', top: 40});
});

test('a page keeps one line of overlap', t => {
	t.deepEqual(press(' ', 0), {action: 'scroll', top: 9});
	t.deepEqual(press('b', 20), {action: 'scroll', top: 11});
	t.deepEqual(press('', 0, {pageDown: true}), {action: 'scroll', top: 9});
});

test('output shorter than the view never scrolls', t => {
	t.deepEqual(
		handleTextViewerKey('G', {}, {top: 0, lineCount: 3, viewHeight: VIEW}),
		{
			action: 'scroll',
			top: 0,
		},
	);
});

test('q and Esc close', t => {
	t.deepEqual(press('q', 5), {action: 'close'});
	t.deepEqual(press('', 5, {escape: true}), {action: 'close'});
});
