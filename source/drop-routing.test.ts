import test from 'ava';
import {hasPointerMotion, parsePointerRecord} from './drop-routing.ts';

test('a pointer move with no button held is motion', t => {
	t.true(hasPointerMotion('\u001B[<35;82;23M'));
	t.true(hasPointerMotion('\u001B[<39;82;23M'), 'with shift');
	t.true(hasPointerMotion('x\u001B[<0;1;1M\u001B[<35;2;2M'));
});

test('clicks, drags and wheel turns are not pointer motion', t => {
	t.false(hasPointerMotion('\u001B[<0;10;5M'), 'press');
	t.false(hasPointerMotion('\u001B[<0;10;5m'), 'release');
	t.false(hasPointerMotion('\u001B[<32;10;5M'), 'drag with the left button');
	t.false(hasPointerMotion('\u001B[<64;10;5M'), 'wheel up');
	t.false(hasPointerMotion('\u001B[200~/tmp/a.png\u001B[201~'));
});

test('pointer records name a pane and a time', t => {
	t.deepEqual(parsePointerRecord('%12 1730800000000'), {
		paneId: '%12',
		at: 1_730_800_000_000,
	});
	t.is(parsePointerRecord(''), undefined);
	t.is(parsePointerRecord('12 1730800000000'), undefined);
});
