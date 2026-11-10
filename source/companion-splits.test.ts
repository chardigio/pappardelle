import test from 'ava';
import {
	MIN_MAIN_PANE,
	parseSplitList,
	splitSignature,
	splitTargets,
} from './companion-splits.ts';

const column = {width: 86, height: 50};

test('a size is cells or a share of the column, and main gives up what each split takes', t => {
	t.deepEqual(
		splitTargets(
			[
				{split: 'down', size: '30%'},
				{split: 'right', size: 20},
			],
			column,
		),
		[15, 20],
	);
});

test('a split with no size takes half of what main has left, whichever space showed before', t => {
	t.deepEqual(
		splitTargets(
			[
				{split: 'down', size: null},
				{split: 'down', size: null},
			],
			column,
		),
		[24, 12],
	);
});

test('a split never leaves main smaller than its frame', t => {
	const [logs] = splitTargets([{split: 'right', size: 85}], column);
	t.is(column.width - logs! - 1, MIN_MAIN_PANE.width);
	const [tests, more] = splitTargets(
		[
			{split: 'down', size: '99%'},
			{split: 'down', size: 10},
		],
		column,
	);
	t.is(tests, column.height - 1 - MIN_MAIN_PANE.height);
	t.is(more, 1);
});

const listing = [
	[
		'companion-r-K~logs',
		'right',
		'',
		'20',
		'%3',
		'bash',
		'40',
		'30',
		'1',
		'',
		'bash',
	],
	[
		'companion-r-K~tests',
		'down',
		'30%',
		'10',
		'%2',
		'make',
		'80',
		'15',
		'0',
		'',
		'make',
	],
	['companion-r-K', '', '', '', '%1', 'sh', '40', '30', '1', '1', 'sh'],
	['companion-r-KEY~x', 'down', '', '5', '%9', 'sh', '1', '1', '0', '', 'sh'],
]
	.map(fields => fields.join('\t'))
	.join('\n');

test('splits are read for their own companion only, in the order they were made', t => {
	const splits = parseSplitList(listing, 'companion-r-K');
	t.deepEqual(
		splits.map(split => [split.name, split.split, split.size, split.shown]),
		[
			['tests', 'down', '30%', false],
			['logs', 'right', null, true],
		],
	);
});

test('the signature follows names, directions and order, not sizes or creation times', t => {
	const splits = parseSplitList(listing, 'companion-r-K');
	const resized = splits.map(split => ({
		...split,
		size: 9,
		order: split.order + 1,
	}));
	t.is(splitSignature(resized), splitSignature(splits));
	t.not(splitSignature([...splits].reverse()), splitSignature(splits));
});
