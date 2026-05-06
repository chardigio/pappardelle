import test from 'ava';
import {
	findPreviousWordBoundary,
	findNextWordBoundary,
	deleteWordBackward,
} from './word-boundary.ts';

// ============================================================================
// findPreviousWordBoundary
// Uses two-class system (word chars vs non-word chars), readline-style:
//   Phase 1: skip non-word chars backward (spaces, punctuation)
//   Phase 2: skip word chars backward (the word itself)
// ============================================================================

test('prev: from end of single word moves to start', t => {
	t.is(findPreviousWordBoundary('hello', 5), 0);
});

test('prev: from middle of word moves to start of that word', t => {
	t.is(findPreviousWordBoundary('hello', 3), 0);
});

test('prev: from start of second word moves to start of first word', t => {
	t.is(findPreviousWordBoundary('hello world', 6), 0);
});

test('prev: skips whitespace before word', t => {
	t.is(findPreviousWordBoundary('hello   world', 8), 0);
});

test('prev: from end of second word moves to start of second word', t => {
	t.is(findPreviousWordBoundary('hello world', 11), 6);
});

test('prev: handles multiple words', t => {
	t.is(findPreviousWordBoundary('one two three', 13), 8);
	t.is(findPreviousWordBoundary('one two three', 8), 4);
	t.is(findPreviousWordBoundary('one two three', 4), 0);
});

test('prev: at position 0 stays at 0', t => {
	t.is(findPreviousWordBoundary('hello', 0), 0);
});

test('prev: treats punctuation as non-word (two-class)', t => {
	// "hello.world" — dot is non-word, treated like a space
	t.is(findPreviousWordBoundary('hello.world', 11), 6);
	t.is(findPreviousWordBoundary('hello.world', 6), 0);
});

test('prev: handles hyphens as non-word boundary', t => {
	t.is(findPreviousWordBoundary('foo-bar', 7), 4);
	t.is(findPreviousWordBoundary('foo-bar', 4), 0);
});

test('prev: skips consecutive non-word chars', t => {
	// ", " and "!" are all non-word — skipped together
	t.is(findPreviousWordBoundary('hello, world!', 13), 7);
	t.is(findPreviousWordBoundary('hello, world!', 7), 0);
});

test('prev: empty string returns 0', t => {
	t.is(findPreviousWordBoundary('', 0), 0);
});

test('prev: handles consecutive spaces', t => {
	t.is(findPreviousWordBoundary('hello    world', 9), 0);
});

// ============================================================================
// findNextWordBoundary
// Uses two-class system (word chars vs non-word chars), readline-style:
//   Phase 1: skip non-word chars forward (spaces, punctuation)
//   Phase 2: skip word chars forward (the word itself)
// ============================================================================

test('next: from start of single word moves to end', t => {
	t.is(findNextWordBoundary('hello', 0), 5);
});

test('next: from middle of word moves to end of that word', t => {
	t.is(findNextWordBoundary('hello', 2), 5);
});

test('next: from end of first word moves to end of second word', t => {
	t.is(findNextWordBoundary('hello world', 5), 11);
});

test('next: skips whitespace then word', t => {
	t.is(findNextWordBoundary('hello   world', 5), 13);
});

test('next: handles multiple words', t => {
	t.is(findNextWordBoundary('one two three', 0), 3);
	t.is(findNextWordBoundary('one two three', 3), 7);
	t.is(findNextWordBoundary('one two three', 7), 13);
});

test('next: at end of string stays at end', t => {
	t.is(findNextWordBoundary('hello', 5), 5);
});

test('next: treats punctuation as non-word (two-class)', t => {
	// "hello.world" — dot is non-word, skipped with phase 1
	t.is(findNextWordBoundary('hello.world', 0), 5);
	t.is(findNextWordBoundary('hello.world', 5), 11);
});

test('next: handles hyphens as non-word boundary', t => {
	t.is(findNextWordBoundary('foo-bar', 0), 3);
	t.is(findNextWordBoundary('foo-bar', 3), 7);
});

test('next: skips consecutive non-word chars', t => {
	// ", " are all non-word — skipped together
	t.is(findNextWordBoundary('hello, world!', 0), 5);
	t.is(findNextWordBoundary('hello, world!', 5), 12);
});

test('next: empty string returns 0', t => {
	t.is(findNextWordBoundary('', 0), 0);
});

// ============================================================================
// deleteWordBackward
// ============================================================================

test('deleteWordBackward: deletes previous word', t => {
	const result = deleteWordBackward('hello world', 11);
	t.is(result.value, 'hello ');
	t.is(result.cursorOffset, 6);
});

test('deleteWordBackward: deletes from middle of word', t => {
	const result = deleteWordBackward('hello world', 8);
	t.is(result.value, 'hello rld');
	t.is(result.cursorOffset, 6);
});

test('deleteWordBackward: deletes first word', t => {
	const result = deleteWordBackward('hello world', 5);
	t.is(result.value, ' world');
	t.is(result.cursorOffset, 0);
});

test('deleteWordBackward: at position 0 does nothing', t => {
	const result = deleteWordBackward('hello', 0);
	t.is(result.value, 'hello');
	t.is(result.cursorOffset, 0);
});

test('deleteWordBackward: handles punctuation as non-word', t => {
	const result = deleteWordBackward('hello.world', 11);
	t.is(result.value, 'hello.');
	t.is(result.cursorOffset, 6);
});

test('deleteWordBackward: deletes trailing non-word chars with word', t => {
	const result = deleteWordBackward('hello   world', 8);
	t.is(result.value, 'world');
	t.is(result.cursorOffset, 0);
});
