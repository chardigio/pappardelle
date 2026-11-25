import {test, expect} from 'bun:test';
import {buildLogsHint} from './error-display-hint.ts';

test('hint mentions truncation only when no errors are hidden', () => {
	const hint = buildLogsHint(0, true);
	expect(hint.startsWith('Truncated')).toBe(true);
	expect(hint.includes('~/.pappardelle/logs/')).toBe(true);
});

test('hint mentions hidden count only when nothing was truncated', () => {
	const hint = buildLogsHint(2, false);
	expect(hint.startsWith('...and 2 more')).toBe(true);
	expect(hint.includes('truncated')).toBe(false);
	expect(hint.includes('~/.pappardelle/logs/')).toBe(true);
});

test('hint surfaces both signals when hidden errors AND visible truncation coexist', () => {
	// Regression for the case where the original ternary silently dropped the
	// truncation signal when hiddenCount > 0.
	const hint = buildLogsHint(2, true);
	expect(hint.includes('2 more')).toBe(true);
	expect(hint.includes('truncated')).toBe(true);
	expect(hint.includes('~/.pappardelle/logs/')).toBe(true);
});
