import test from 'ava';
import {buildTitledBorderTop} from './titled-border.ts';

test('double style uses the double-line corners and fill', t => {
	const parts = buildTitledBorderTop('Profile', 20, 'double');
	t.is(parts.prefix, '╔');
	t.is(parts.label, ' Profile ');
	t.is(parts.suffix, '═'.repeat(9) + '╗');
});

test('round style uses the rounded corners and single-line fill', t => {
	const parts = buildTitledBorderTop('Profile', 20, 'round');
	t.is(parts.prefix, '╭');
	t.is(parts.label, ' Profile ');
	t.is(parts.suffix, '─'.repeat(9) + '╮');
});

test('the assembled line is exactly the requested width', t => {
	for (const width of [12, 20, 33, 80]) {
		const {prefix, label, suffix} = buildTitledBorderTop(
			'New Session',
			width,
			'double',
		);
		t.is((prefix + label + suffix).length, width, `width ${width}`);
	}
});

test('a title that would overflow is truncated with an ellipsis', t => {
	const {prefix, label, suffix} = buildTitledBorderTop(
		'An Extremely Long Dialog Title',
		14,
		'double',
	);
	t.is((prefix + label + suffix).length, 14);
	t.true(label.includes('…'));
	t.is(label[0], ' ');
	t.is(label.at(-1), ' ');
});

test('an empty title still produces a well-formed border', t => {
	const {prefix, label, suffix} = buildTitledBorderTop('', 10, 'double');
	t.is(prefix, '╔');
	t.is(label, '');
	t.is(suffix, '═'.repeat(8) + '╗');
});

test('degenerate widths never produce a negative-length fill', t => {
	for (const width of [0, 1, 2, 3]) {
		const {prefix, label, suffix} = buildTitledBorderTop(
			'Profile',
			width,
			'double',
		);
		const line = prefix + label + suffix;
		t.true(line.length >= 2, `width ${width} → ${JSON.stringify(line)}`);
		t.is(line[0], '╔');
		t.is(line.at(-1), '╗');
	}
});

test('the label always keeps one space of padding on each side', t => {
	const {label} = buildTitledBorderTop('X', 40, 'double');
	t.is(label, ' X ');
});
