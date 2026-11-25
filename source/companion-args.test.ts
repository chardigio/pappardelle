import {test, expect} from 'bun:test';
import {
	CompanionUsageError,
	commandFromArgs,
	parseCompanionArgs,
} from './companion-args.ts';

test('a non-verb first argument is the shortcut for run on main', () => {
	expect(parseCompanionArgs(['hunk', 'diff', '--watch'])).toStrictEqual({
		verb: 'run',
		pane: 'main',
		split: 'down',
		command: "'hunk' 'diff' '--watch'",
	});
});

test('the shortcut passes its flags to the command, --space included', () => {
	// --space here belongs to the wrapped command; the shortcut always targets
	// the caller's own space.
	const parsed = parseCompanionArgs(['mytool', '--space', 'STA-9']);
	expect(parsed).toMatchObject({
		verb: 'run',
		command: "'mytool' '--space' 'STA-9'",
	});
	expect((parsed as {space?: string}).space).toBe(undefined);
});

test('a command named like a verb needs run --', () => {
	expect(parseCompanionArgs(['list'])).toMatchObject({verb: 'list'});
	expect(parseCompanionArgs(['run', '--', 'list', '-la'])).toMatchObject({
		verb: 'run',
		command: "'list' '-la'",
	});
});

test('a leading flag that is not --help is rejected', () => {
	expect(() => parseCompanionArgs(['--space', 'X', 'list'])).toThrow(
		CompanionUsageError,
	);
});

test('no arguments or --help prints help', () => {
	expect(parseCompanionArgs([]).verb).toBe('help');
	expect(parseCompanionArgs(['--help']).verb).toBe('help');
	expect(parseCompanionArgs(['run', '--help']).verb).toBe('help');
});

test('one command argument is a shell line, several are quoted', () => {
	expect(commandFromArgs(['make 2>&1 | less'])).toBe('make 2>&1 | less');
	expect(commandFromArgs(['echo', "it's here"])).toBe(`'echo' 'it'\\''s here'`);
});

test('run parses pane, split, size and space before --', () => {
	expect(
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
	).toStrictEqual({
		verb: 'run',
		space: 'STA-1',
		pane: 'app',
		split: 'right',
		size: '40%',
		command: "'npm' 'run' 'dev'",
	});
});

test('run flags after -- belong to the command', () => {
	expect(parseCompanionArgs(['run', '--', 'ls', '--pane', 'x'])).toMatchObject({
		pane: 'main',
		command: "'ls' '--pane' 'x'",
	});
});

test('run rejects a bad split, a bad size, and a missing command', () => {
	expect(() =>
		parseCompanionArgs(['run', '--split', 'left', '--', 'x']),
	).toThrow(CompanionUsageError);
	expect(() => parseCompanionArgs(['run', '--size', '0', '--', 'x'])).toThrow(
		CompanionUsageError,
	);
	expect(() => parseCompanionArgs(['run', '--size', 'big', '--', 'x'])).toThrow(
		CompanionUsageError,
	);
	expect(() => parseCompanionArgs(['run'])).toThrow(CompanionUsageError);
});

test('keys takes text, --no-enter, or repeated --keys but not text and keys', () => {
	expect(
		parseCompanionArgs(['keys', '--pane', 'repl', 'print(1)']),
	).toMatchObject({
		pane: 'repl',
		text: 'print(1)',
		enter: true,
		keys: [],
	});
	expect(parseCompanionArgs(['keys', '--no-enter', '--', '-x'])).toMatchObject({
		text: '-x',
		enter: false,
	});
	expect(
		parseCompanionArgs(['keys', '--keys', 'q', '--keys', 'Escape']),
	).toMatchObject({
		keys: ['q', 'Escape'],
		text: undefined,
	});
	expect(() => parseCompanionArgs(['keys', '--keys', 'q', 'hello'])).toThrow(
		CompanionUsageError,
	);
});

test('read defaults to 50 lines on main', () => {
	expect(parseCompanionArgs(['read'])).toStrictEqual({
		verb: 'read',
		space: undefined,
		pane: 'main',
		lines: 50,
	});
	expect(() => parseCompanionArgs(['read', '--lines', '-3'])).toThrow(
		CompanionUsageError,
	);
});

test('resize needs a name and a size', () => {
	expect(parseCompanionArgs(['resize', 'app', '--size', '10'])).toMatchObject({
		pane: 'app',
		size: 10,
	});
	expect(parseCompanionArgs(['resize', 'app', '--size', '30%'])).toMatchObject({
		size: '30%',
	});
	for (const argv of [
		['resize', 'app'],
		['resize', '--size', '10'],
		['resize', 'app', '--size', '0'],
		['resize', 'app', '--width', '10'],
	]) {
		expect(() => parseCompanionArgs(argv)).toThrow(CompanionUsageError);
	}
});

test('pane names are what a split session name can hold', () => {
	expect(
		parseCompanionArgs(['run', '--pane', 'dev-2', '--', 'x']),
	).toMatchObject({
		pane: 'dev-2',
	});
	for (const name of ['Dev', 'a~b', 'a.b', '-x', 'a b', '']) {
		expect(() => parseCompanionArgs(['read', '--pane', name])).toThrow(
			CompanionUsageError,
		);
	}
});

test('width takes columns, a percentage, or reset', () => {
	expect(parseCompanionArgs(['width', '60'])).toMatchObject({width: 60});
	expect(parseCompanionArgs(['width', '40%'])).toMatchObject({width: '40%'});
	expect(parseCompanionArgs(['width', 'reset', '--space', 'B'])).toMatchObject({
		width: 'reset',
		space: 'B',
	});
	for (const bad of ['0', '150%', 'wide']) {
		expect(() => parseCompanionArgs(['width', bad])).toThrow(
			CompanionUsageError,
		);
	}

	expect(() => parseCompanionArgs(['width'])).toThrow(CompanionUsageError);
});

test('unknown flags on a verb are usage errors', () => {
	expect(() => parseCompanionArgs(['list', '--wide'])).toThrow(
		CompanionUsageError,
	);
});
