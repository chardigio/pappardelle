import {test, expect} from 'bun:test';
import {FrameInputRouter} from './frame-input.ts';

const ESC = '\u001B';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Feeds each read in turn and names where its bytes went. */
function routed(...reads: string[]): string[] {
	const router = new FrameInputRouter();
	return reads.flatMap(read =>
		router
			.route(encoder.encode(read))
			.map(segment => `${segment.to}:${decoder.decode(segment.bytes)}`),
	);
}

test('typed text and keys go to the program as they arrived', () => {
	for (const keys of [
		'hello',
		ESC,
		`${ESC}x`,
		`${ESC}[A`,
		`${ESC}OA`,
		`${ESC}[1;5C`,
		`${ESC}[13;2u`,
		`${ESC}[27;2;13~`,
		`${ESC}[Z`,
		`${ESC}${ESC}[A`,
		`a${ESC}b${ESC}[Bc`,
		`${ESC}éa`,
		'日本語',
	]) {
		expect(routed(keys)).toStrictEqual([`program:${keys}`]);
	}
});

test('Alt with a character that opens a sequence does not take what follows', () => {
	for (const keys of [
		`${ESC}[`,
		`${ESC}O`,
		`${ESC}P`,
		`${ESC}]`,
		`${ESC}_`,
		`${ESC}_hello`,
		`${ESC}Phello`,
		`${ESC}]hello`,
	]) {
		expect(routed(keys)).toStrictEqual([`program:${keys}`]);
	}
});

test('a key sequence cut short is still the program’s, in the pieces it came in', () => {
	expect(routed(`${ESC}[1;5`, 'C')).toStrictEqual([
		`program:${ESC}[1;5`,
		'program:C',
	]);
	expect(routed(`${ESC}[`, 'A')).toStrictEqual([
		`program:${ESC}[`,
		'program:A',
	]);
});

test('Shift, Ctrl or Alt with F3 is a key, not a cursor position report', () => {
	expect(routed(`${ESC}[1;2R`)).toStrictEqual([`program:${ESC}[1;2R`]);
	expect(routed(`${ESC}[1;5R`)).toStrictEqual([`program:${ESC}[1;5R`]);
	expect(routed(`${ESC}[24;80R`)).toStrictEqual([`renderer:${ESC}[24;80R`]);
	expect(routed(`${ESC}[1;1R`)).toStrictEqual([`renderer:${ESC}[1;1R`]);
});

test('mouse reports, focus reports and the terminal’s replies go to the renderer', () => {
	for (const report of [
		`${ESC}[<0;12;7M`,
		`${ESC}[<0;12;7m`,
		`${ESC}[M !!`,
		`${ESC}[I`,
		`${ESC}[O`,
		`${ESC}[?62;22c`,
		`${ESC}[>0;10;1c`,
		`${ESC}[?2026;2$y`,
		`${ESC}[4;1040;1600t`,
		`${ESC}[?997;1n`,
		`${ESC}[?1u`,
		`${ESC}]11;rgb:0000/2b2b/3636${ESC}\\`,
		`${ESC}]4;1;rgb:dcdc/3232/2f2f\u0007`,
		`${ESC}P>|tmux 3.8${ESC}\\`,
		`${ESC}_Gi=31337;OK${ESC}\\`,
	]) {
		expect(routed(report)).toStrictEqual([`renderer:${report}`]);
	}
});

test('a read holding a key and a report is split in order', () => {
	expect(routed(`a${ESC}[<0;3;4M${ESC}[Ab${ESC}[I`)).toStrictEqual([
		'program:a',
		`renderer:${ESC}[<0;3;4M`,
		`program:${ESC}[Ab`,
		`renderer:${ESC}[I`,
	]);
});

test('a reply or a mouse report split across reads stays with the renderer', () => {
	expect(routed(`${ESC}]11;rgb:0000/`, `2b2b/3636${ESC}`, '\\x')).toStrictEqual(
		[
			`renderer:${ESC}]11;rgb:0000/`,
			`renderer:2b2b/3636${ESC}`,
			'renderer:\\',
			'program:x',
		],
	);
	expect(routed(`${ESC}[<0;1`, '2;7Mj')).toStrictEqual([
		`renderer:${ESC}[<0;1`,
		'renderer:2;7M',
		'program:j',
	]);
});

test('a paste goes to the renderer whole, however it is split, and keys after it do not', () => {
	const paste = `${ESC}[200~rm -rf ${ESC}x\n${ESC}[A${ESC}[201~`;
	expect(routed(`${paste}j`)).toStrictEqual([`renderer:${paste}`, 'program:j']);
	expect(routed(`k${ESC}[200~one`, `two${ESC}[20`, '1~l')).toStrictEqual([
		'program:k',
		`renderer:${ESC}[200~one`,
		`renderer:two${ESC}[20`,
		'renderer:1~',
		'program:l',
	]);
});

test('an unfinished reply does not hold later typing', () => {
	const router = new FrameInputRouter();
	const to = (read: string, now: number) =>
		router.route(encoder.encode(read), now).map(segment => segment.to);
	expect(to(`${ESC}]1hello`, 0)).toStrictEqual(['renderer']);
	expect(to('x', 50)).toStrictEqual(['renderer']);
	expect(to('y', 150)).toStrictEqual(['program']);
});

test('the rest of a mouse report is the renderer’s however late it is read', () => {
	const router = new FrameInputRouter();
	const route = (read: string, now: number) =>
		router
			.route(encoder.encode(read), now)
			.map(segment => `${segment.to}:${decoder.decode(segment.bytes)}`);
	expect(route(`${ESC}[<35;11`, 0)).toStrictEqual([`renderer:${ESC}[<35;11`]);
	expect(route(';6Mj', 5000)).toStrictEqual(['renderer:;6M', 'program:j']);
});

test('a key after half a mouse report is not taken as the rest of it', () => {
	expect(routed(`${ESC}[<35;11`, `${ESC}[A`)).toStrictEqual([
		`renderer:${ESC}[<35;11`,
		`program:${ESC}[A`,
	]);
});

test('a read that ends inside a sequence holds its last bytes for the next', () => {
	const router = new FrameInputRouter();
	const route = (read: string) =>
		router
			.route(encoder.encode(read))
			.map(segment => `${segment.to}:${decoder.decode(segment.bytes)}`);
	// A stream of mouse reports read faster than it is written.
	expect(route(`${ESC}[<35;20;2M${ESC}`)).toStrictEqual([
		`renderer:${ESC}[<35;20;2M`,
	]);
	expect(router.isHolding).toBe(true);
	expect(route(`[<35;21;2M${ESC}[`)).toStrictEqual([
		`renderer:${ESC}[<35;21;2M`,
	]);
	expect(route('<35;22;2Mj')).toStrictEqual([
		`renderer:${ESC}[<35;22;2M`,
		'program:j',
	]);
	expect(router.isHolding).toBe(false);
});

test('held bytes that nothing follows are the program’s', () => {
	const router = new FrameInputRouter();
	expect(
		router.route(encoder.encode(`a${ESC}`)).map(segment => segment.to),
	).toStrictEqual(['program']);
	expect(decoder.decode(router.release())).toBe(ESC);
	expect(router.isHolding).toBe(false);
	expect(router.release()).toBe(undefined);
});

test("a graphics reply to the program's own command goes to the program", () => {
	expect(routed(`${ESC}_Gi=65537;OK${ESC}\\`)).toStrictEqual([
		`program:${ESC}_Gi=65537;OK${ESC}\\`,
	]);
	expect(routed(`${ESC}_Gi=7;ENOENT:`, `no such file${ESC}\\a`)).toStrictEqual([
		`program:${ESC}_Gi=7;ENOENT:`,
		`program:no such file${ESC}\\a`,
	]);
});

test("the frame's own depth probe answers go to the renderer", () => {
	expect(routed(`${ESC}_Gi=31342;OK${ESC}\\`)).toStrictEqual([
		`renderer:${ESC}_Gi=31342;OK${ESC}\\`,
	]);
});
