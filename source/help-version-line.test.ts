import test from 'ava';
import {formatVersionLine} from './help-version-line.ts';

test('formatVersionLine: renders version and sha when version already has leading v', t => {
	t.is(formatVersionLine('v0.1.0', 'abc1234'), 'pappardelle v0.1.0 (abc1234)');
});

test('formatVersionLine: normalizes bare semver to include leading v', t => {
	t.is(formatVersionLine('0.1.0', 'abc1234'), 'pappardelle v0.1.0 (abc1234)');
});

test('formatVersionLine: falls back to sha-only line when version is null', t => {
	t.is(formatVersionLine(null, 'abc1234'), 'pappardelle (abc1234)');
});

test('formatVersionLine: falls back to sha-only line when version is undefined', t => {
	t.is(formatVersionLine(undefined, 'abc1234'), 'pappardelle (abc1234)');
});

test('formatVersionLine: falls back to sha-only line when version is empty string', t => {
	t.is(formatVersionLine('', 'abc1234'), 'pappardelle (abc1234)');
});
