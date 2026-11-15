import test from 'ava';
import {
	CompanionUsageError,
	commandFromArgs,
	parseCompanionArgs,
} from './companion-args.ts';

test('a non-verb first argument is the shortcut for run on main', t => {
	t.deepEqual(parseCompanionArgs(['hunk', 'diff', '--watch']), {
		verb: 'run',
		pane: 'main',
		split: 'down',
		command: "'hunk' 'diff' '--watch'",
	});
});

test('the shortcut passes its flags to the command, --space included', t => {
	// --space here belongs to the wrapped command; the shortcut always targets
	// the caller's own space.
	const parsed = parseCompanionArgs(['mytool', '--space', 'STA-9']);
	t.like(parsed, {verb: 'run', command: "'mytool' '--space' 'STA-9'"});
	t.is((parsed as {space?: string}).space, undefined);
});

test('a command named like a verb needs run --', t => {
	t.like(parseCompanionArgs(['list']), {verb: 'list'});
	t.like(parseCompanionArgs(['run', '--', 'list', '-la']), {
		verb: 'run',
		command: "'list' '-la'",
	});
});

test('a leading flag that is not --help is rejected', t => {
	t.throws(() => parseCompanionArgs(['--space', 'X', 'list']), {
		instanceOf: CompanionUsageError,
	});
});

test('no arguments or --help prints help', t => {
	t.is(parseCompanionArgs([]).verb, 'help');
	t.is(parseCompanionArgs(['--help']).verb, 'help');
	t.is(parseCompanionArgs(['run', '--help']).verb, 'help');
});

test('one command argument is a shell line, several are quoted', t => {
	t.is(commandFromArgs(['make 2>&1 | less']), 'make 2>&1 | less');
	t.is(commandFromArgs(['echo', "it's here"]), `'echo' 'it'\\''s here'`);
});

test('run parses pane, split, size and space before --', t => {
	t.deepEqual(
		parseCompanionArgs([
			'run',
			'--space',
			'STA-1',
			'--pane',
			'app',
			'--split',
			'right',
			'--size',
			'40%',
			'--',
			'npm',
			'run',
			'dev',
		]),
		{
			verb: 'run',
			space: 'STA-1',
			pane: 'app',
			split: 'right',
			size: '40%',
			command: "'npm' 'run' 'dev'",
		},
	);
});

test('run flags after -- belong to the command', t => {
	t.like(parseCompanionArgs(['run', '--', 'ls', '--pane', 'x']), {
		pane: 'main',
		command: "'ls' '--pane' 'x'",
	});
});

test('run rejects a bad split, a bad size, and a missing command', t => {
	t.throws(() => parseCompanionArgs(['run', '--split', 'left', '--', 'x']), {
		instanceOf: CompanionUsageError,
	});
	t.throws(() => parseCompanionArgs(['run', '--size', '0', '--', 'x']), {
		instanceOf: CompanionUsageError,
	});
	t.throws(() => parseCompanionArgs(['run', '--size', 'big', '--', 'x']), {
		instanceOf: CompanionUsageError,
	});
	t.throws(() => parseCompanionArgs(['run']), {
		instanceOf: CompanionUsageError,
	});
});

test('keys takes text, --no-enter, or repeated --keys but not text and keys', t => {
	t.like(parseCompanionArgs(['keys', '--pane', 'repl', 'print(1)']), {
		pane: 'repl',
		text: 'print(1)',
		enter: true,
		keys: [],
	});
	t.like(parseCompanionArgs(['keys', '--no-enter', '--', '-x']), {
		text: '-x',
		enter: false,
	});
	t.like(parseCompanionArgs(['keys', '--keys', 'q', '--keys', 'Escape']), {
		keys: ['q', 'Escape'],
		text: undefined,
	});
	t.throws(() => parseCompanionArgs(['keys', '--keys', 'q', 'hello']), {
		instanceOf: CompanionUsageError,
	});
});

test('read defaults to 50 lines on main', t => {
	t.deepEqual(parseCompanionArgs(['read']), {
		verb: 'read',
		space: undefined,
		pane: 'main',
		lines: 50,
	});
	t.throws(() => parseCompanionArgs(['read', '--lines', '-3']), {
		instanceOf: CompanionUsageError,
	});
});

test('resize needs a name and a size', t => {
	t.like(parseCompanionArgs(['resize', 'app', '--size', '10']), {
		pane: 'app',
		size: 10,
	});
	t.like(parseCompanionArgs(['resize', 'app', '--size', '30%']), {
		size: '30%',
	});
	for (const argv of [
		['resize', 'app'],
		['resize', '--size', '10'],
		['resize', 'app', '--size', '0'],
		['resize', 'app', '--width', '10'],
	]) {
		t.throws(() => parseCompanionArgs(argv), {
			instanceOf: CompanionUsageError,
		});
	}
});

test('pane names are what a split session name can hold', t => {
	t.like(parseCompanionArgs(['run', '--pane', 'dev-2', '--', 'x']), {
		pane: 'dev-2',
	});
	for (const name of ['Dev', 'a~b', 'a.b', '-x', 'a b', '']) {
		t.throws(() => parseCompanionArgs(['read', '--pane', name]), {
			instanceOf: CompanionUsageError,
		});
	}
});

test('width takes columns, a percentage, or reset', t => {
	t.like(parseCompanionArgs(['width', '60']), {width: 60});
	t.like(parseCompanionArgs(['width', '40%']), {width: '40%'});
	t.like(parseCompanionArgs(['width', 'reset', '--space', 'B']), {
		width: 'reset',
		space: 'B',
	});
	for (const bad of ['0', '150%', 'wide']) {
		t.throws(() => parseCompanionArgs(['width', bad]), {
			instanceOf: CompanionUsageError,
		});
	}

	t.throws(() => parseCompanionArgs(['width']), {
		instanceOf: CompanionUsageError,
	});
});

test('unknown flags on a verb are usage errors', t => {
	t.throws(() => parseCompanionArgs(['list', '--wide']), {
		instanceOf: CompanionUsageError,
	});
});
