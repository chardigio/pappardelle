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

test("--help on close, restart or update prints that command's help and runs nothing", t => {
	for (const argv of [
		['close', '--help'],
		['close', 'STA-1', '--yes', '-h'],
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

test('close, restart and update reject flags that are not theirs', t => {
	const usages: Record<string, string> = {
		close: 'Usage: pappardelle close <issue-key> [--yes]',
		restart: 'Usage: pappardelle restart [--hard [--yes]]',
		update: 'Usage: pappardelle update [--restart-tuis | --no-restart-tuis]',
	};
	for (const [argv, flag] of [
		[['close', 'STA-1', '--bogus'], '--bogus'],
		[['close', 'STA-1', '--hard'], '--hard'],
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
				usages[argv[0]],
				`Run pappardelle ${argv[0]} --help for details`,
			]);
		}
	}
});

test('known flags and every other command pass through', t => {
	for (const argv of [
		['close', 'STA-1'],
		['close', 'STA-1', '--yes'],
		['close', 'STA-1', '--yes', '--teardown-only'],
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

test('--resume accepts either position without consuming the input', t => {
	for (const argv of [
		['--resume', 'STE-20'],
		['STE-20', '--resume'],
	]) {
		const cli = parseCli(argv);
		t.true(cli.flags.resume);
		t.deepEqual(cli.input, ['STE-20']);
	}

	t.is(parseCli(['STE-20']).flags.resume, undefined);
	t.false(parseCli(['STE-20', '--no-resume']).flags.resume);
	t.deepEqual(parseCli(['--resume', 'fix auth bug']).input, ['fix auth bug']);
});

test('--profile preserves its name and positional input in either order', t => {
	for (const argv of [
		['--profile', 'mobile', 'STE-20'],
		['STE-20', '--profile', 'mobile'],
	]) {
		const cli = parseCli(argv);
		t.is(cli.flags.profile, 'mobile');
		t.deepEqual(cli.input, ['STE-20']);
	}
	t.is(parseCli(['--profile', '123', 'STE-20']).flags.profile, '123');
	t.is(parseCli(['STE-20']).flags.profile, undefined);
});

test('close --help documents --yes but not the internal --teardown-only', t => {
	const gate = subcommandGate(['close', '--help']);
	t.is(gate.action, 'help');
	if (gate.action === 'help') {
		t.true(gate.text.includes('--yes'));
		t.false(gate.text.includes('--teardown-only'));
	}

	t.false(parseCli([]).help.includes('--teardown-only'));
	t.true(parseCli(['close', 'STA-1', '--teardown-only']).flags.teardownOnly);
});
