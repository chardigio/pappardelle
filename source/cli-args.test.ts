import test from 'ava';
import {parseCli} from './cli-args.ts';

test('--restart-tuis is unset unless passed, so update can ask on a TTY', t => {
	t.is(parseCli(['update']).flags.restartTuis, undefined);
	t.is(parseCli(['update', '--restart-tuis']).flags.restartTuis, true);
	t.is(parseCli(['update', '--no-restart-tuis']).flags.restartTuis, false);
});

test('restart --hard and --yes are unset unless passed', t => {
	t.is(parseCli(['restart']).flags.hard, undefined);
	t.is(parseCli(['restart']).flags.yes, undefined);
	t.true(parseCli(['restart', '--hard', '--yes']).flags.hard);
	t.true(parseCli(['restart', '--hard', '--yes']).flags.yes);
});

test('--layout still defaults on', t => {
	t.true(parseCli([]).flags.layout);
	t.false(parseCli(['--no-layout']).flags.layout);
});
