import test from 'ava';
import {parseCli} from './cli-args.ts';

test('--kill-tuis is unset unless passed, so update can ask on a TTY', t => {
	t.is(parseCli(['update']).flags.killTuis, undefined);
	t.is(parseCli(['update', '--kill-tuis']).flags.killTuis, true);
	t.is(parseCli(['update', '--no-kill-tuis']).flags.killTuis, false);
});

test('--layout still defaults on', t => {
	t.true(parseCli([]).flags.layout);
	t.false(parseCli(['--no-layout']).flags.layout);
});
