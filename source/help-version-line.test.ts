import {test, expect} from 'bun:test';
import {formatVersionLine} from './help-version-line.ts';

test('formatVersionLine: renders version and sha when version already has leading v', () => {
	expect(formatVersionLine('v0.1.0', 'abc1234')).toBe(
		'pappardelle v0.1.0 (abc1234)',
	);
});

test('formatVersionLine: normalizes bare semver to include leading v', () => {
	expect(formatVersionLine('0.1.0', 'abc1234')).toBe(
		'pappardelle v0.1.0 (abc1234)',
	);
});

test('formatVersionLine: falls back to sha-only line when version is null', () => {
	expect(formatVersionLine(null, 'abc1234')).toBe('pappardelle (abc1234)');
});

test('formatVersionLine: falls back to sha-only line when version is undefined', () => {
	expect(formatVersionLine(undefined, 'abc1234')).toBe('pappardelle (abc1234)');
});

test('formatVersionLine: falls back to sha-only line when version is empty string', () => {
	expect(formatVersionLine('', 'abc1234')).toBe('pappardelle (abc1234)');
});

test('formatVersionLine: appends -dev marker for dev builds (tag already has v)', () => {
	expect(formatVersionLine('v0.7.9', 'abc1234', true)).toBe(
		'pappardelle v0.7.9-dev (abc1234)',
	);
});

test('formatVersionLine: appends -dev marker for dev builds (bare semver)', () => {
	expect(formatVersionLine('0.7.9', 'abc1234', true)).toBe(
		'pappardelle v0.7.9-dev (abc1234)',
	);
});

test('formatVersionLine: isDev=false renders the plain release line', () => {
	expect(formatVersionLine('v0.7.9', 'abc1234', false)).toBe(
		'pappardelle v0.7.9 (abc1234)',
	);
});

test('formatVersionLine: isDev is ignored when there is no version (still sha-only)', () => {
	expect(formatVersionLine(null, 'abc1234', true)).toBe(
		'pappardelle (abc1234)',
	);
});
