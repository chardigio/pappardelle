import test from 'ava';
import {parseCli} from './cli-args.ts';

test('--restart-tuis is unset unless passed, so update can ask on a TTY', t => {
	t.is(parseCli(['update']).flags.restartTuis, undefined);
	t.is(parseCli(['update', '--restart-tuis']).flags.restartTuis, true);
	t.is(parseCli(['update', '--no-restart-tuis']).flags.restartTuis, false);
});

test('--layout still defaults on', t => {
	t.true(parseCli([]).flags.layout);
	t.false(parseCli(['--no-layout']).flags.layout);
});
