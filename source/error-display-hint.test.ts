import test from 'ava';
import {buildLogsHint} from './error-display-hint.ts';

test('hint mentions truncation only when no errors are hidden', t => {
	const hint = buildLogsHint(0, true);
	t.true(hint.startsWith('Truncated'));
	t.true(hint.includes('~/.pappardelle/logs/'));
});

test('hint mentions hidden count only when nothing was truncated', t => {
	const hint = buildLogsHint(2, false);
	t.true(hint.startsWith('...and 2 more'));
	t.false(hint.includes('truncated'));
	t.true(hint.includes('~/.pappardelle/logs/'));
});

test('hint surfaces both signals when hidden errors AND visible truncation coexist', t => {
	// Regression for the case where the original ternary silently dropped the
	// truncation signal when hiddenCount > 0.
	const hint = buildLogsHint(2, true);
	t.true(hint.includes('2 more'));
	t.true(hint.includes('truncated'));
	t.true(hint.includes('~/.pappardelle/logs/'));
});
