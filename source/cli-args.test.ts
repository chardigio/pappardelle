import test from 'ava';
import {parseCli, subcommandGate} from './cli-args.ts';

test('--restart-tuis is unset unless passed, so update can ask on a TTY', t => {
	t.is(parseCli(['update']).flags.restartTuis, undefined);
	t.is(parseCli(['update', '--restart-tuis']).flags.restartTuis, true);
	t.is(parseCli(['update', '--no-restart-tuis']).flags.restartTuis, false);
});

test('--layout still defaults on', t => {
	t.true(parseCli([]).flags.layout);
	t.false(parseCli(['--no-layout']).flags.layout);
});

test("--help on restart or update prints that command's help and runs nothing", t => {
	for (const argv of [
		['restart', '--help'],
		['restart', '--hard', '--yes', '-h'],
		['update', '--help'],
	]) {
		const gate = subcommandGate(argv);
		t.is(gate.action, 'help');
		if (gate.action === 'help') {
			t.true(gate.text.includes(`$ pappardelle ${argv[0]}`));
		}
	}
});

test('restart and update reject flags that are not theirs', t => {
	for (const [argv, flag] of [
		[['restart', '--bogus'], '--bogus'],
		[['restart', '--restart-tuis'], '--restart-tuis'],
		[['update', '--hard'], '--hard'],
		[['update', '--restart-tuis', '--no-layout'], '--no-layout'],
	] as const) {
		const gate = subcommandGate(argv);
		t.is(gate.action, 'reject');
		if (gate.action === 'reject') {
			t.deepEqual(gate.message.split('\n'), [
				`Unknown flag ${flag} for pappardelle ${argv[0]}`,
				argv[0] === 'restart'
					? 'Usage: pappardelle restart [--hard [--yes]]'
					: 'Usage: pappardelle update [--restart-tuis | --no-restart-tuis]',
				`Run pappardelle ${argv[0]} --help for details`,
			]);
		}
	}
});

test('known flags and every other command pass through', t => {
	for (const argv of [
		['restart'],
		['restart', '--hard', '--yes'],
		['update', '--restart-tuis'],
		['update', '--no-restart-tuis'],
		[],
		['--no-layout'],
		['fix the --verbose flag'],
		['send', 'STA-1', '--help'],
	]) {
		t.deepEqual(subcommandGate(argv), {action: 'run'});
	}
});
