import {test, expect} from 'bun:test';
import {hasPointerMotion, parsePointerRecord} from './drop-routing.ts';

test('a pointer move with no button held is motion', () => {
	expect(hasPointerMotion('\u001B[<35;82;23M')).toBe(true);
	expect(hasPointerMotion('\u001B[<39;82;23M'), 'with shift').toBe(true);
	expect(hasPointerMotion('x\u001B[<0;1;1M\u001B[<35;2;2M')).toBe(true);
});

test('clicks, drags and wheel turns are not pointer motion', () => {
	expect(hasPointerMotion('\u001B[<0;10;5M'), 'press').toBe(false);
	expect(hasPointerMotion('\u001B[<0;10;5m'), 'release').toBe(false);
	expect(
		hasPointerMotion('\u001B[<32;10;5M'),
		'drag with the left button',
	).toBe(false);
	expect(hasPointerMotion('\u001B[<64;10;5M'), 'wheel up').toBe(false);
	expect(hasPointerMotion('\u001B[200~/tmp/a.png\u001B[201~')).toBe(false);
});

test('pointer records name a pane and a time', () => {
	expect(parsePointerRecord('%12 1730800000000')).toStrictEqual({
		paneId: '%12',
		at: 1_730_800_000_000,
	});
	expect(parsePointerRecord('')).toBe(undefined);
	expect(parsePointerRecord('12 1730800000000')).toBe(undefined);
});
