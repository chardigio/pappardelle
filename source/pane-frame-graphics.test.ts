import {test, expect} from 'bun:test';
import {
	FramedOutput,
	GraphicsForwarder,
	wrapForTmux,
} from './pane-frame-graphics.ts';

const ESC = '\u001B';
const command = `${ESC}_Ga=d,d=I,i=7,q=2${ESC}\\`;

test('each tmux layer gets its own passthrough, with escapes doubled', () => {
	expect(wrapForTmux(command, 0)).toBe(command);
	expect(wrapForTmux(command, 1)).toBe(
		`${ESC}Ptmux;${ESC}${ESC}_Ga=d,d=I,i=7,q=2${ESC}${ESC}\\${ESC}\\`,
	);
	expect(wrapForTmux(command, 2)).toBe(
		`${ESC}Ptmux;${ESC}${ESC}Ptmux;${ESC}${ESC}${ESC}${ESC}_Ga=d,d=I,i=7,q=2${ESC}${ESC}${ESC}${ESC}\\${ESC}${ESC}\\${ESC}\\`,
	);
});

test('outside tmux a command is written as it came', () => {
	const written: string[] = [];
	const forwarder = new GraphicsForwarder(sequence => {
		written.push(sequence);
		return true;
	}, false);
	forwarder.probe();
	forwarder.forward(command);
	expect(written).toStrictEqual([command]);
});

test('inside tmux commands wait for the probe, then go out wrapped for the depth that answered', () => {
	const written: string[] = [];
	const forwarder = new GraphicsForwarder(sequence => {
		written.push(sequence);
		return true;
	}, true);
	forwarder.probe();
	const probes = written.splice(0);
	expect(probes.length).toBe(1);
	expect(probes[0]!.includes('i=31342')).toBe(true);

	forwarder.forward(command);
	expect(written).toStrictEqual([]);
	forwarder.readReplies(`${ESC}_Gi=65537;OK${ESC}\\${ESC}_Gi=31342;OK${ESC}\\`);
	expect(written).toStrictEqual([wrapForTmux(command, 2)]);

	forwarder.forward(command);
	expect(written.at(-1)).toStrictEqual(wrapForTmux(command, 2));
	forwarder.dispose();
});

// Records what reaches the terminal in order, runs timers by hand and counts
// frame requests.
function framedOutput() {
	const written: string[] = [];
	const timers: Array<{at: number; callback: () => void}> = [];
	let now = 0;
	let frameRequests = 0;
	const output = new FramedOutput({
		writeScreen(bytes) {
			written.push(new TextDecoder().decode(bytes));
		},
		writeGraphics(commands) {
			written.push(
				...commands.map(({command}) => `<${command.slice(3).split(';')[0]!}>`),
			);
			return true;
		},
		requestFrame() {
			frameRequests++;
		},
		schedule(callback, ms) {
			const timer = {at: now + ms, callback};
			timers.push(timer);
			return () => {
				timers.splice(timers.indexOf(timer), 1);
			};
		},
	});
	return {
		output,
		written,
		get frameRequests() {
			return frameRequests;
		},
		advance(ms: number) {
			now += ms;
			for (const timer of timers.filter(timer => timer.at <= now)) {
				timers.splice(timers.indexOf(timer), 1);
				timer.callback();
			}
		},
	};
}

const screen = (text: string) => ({screen: new TextEncoder().encode(text)});
const graphics = (keys: string) => ({graphics: `${ESC}_G${keys};AAAA${ESC}\\`});

test('output with no graphics before it goes to the screen at once', () => {
	const framed = framedOutput();
	framed.output.receive([screen('hello')]);
	expect(framed.written).toStrictEqual(['hello']);
	expect(framed.frameRequests).toBe(0);
});

test('an image frame arriving over several reads reaches one renderer frame whole', () => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1,m=1'), screen('\u001B[1;1H')]);
	framed.output.receive([graphics('m=0'), screen('row 1 ')]);
	framed.output.receive([screen('row 2')]);
	framed.output.flushFrame();
	expect(
		framed.written,
		'nothing is drawn before the program pauses',
	).toStrictEqual([]);

	framed.advance(4);
	expect(framed.frameRequests > 0).toBe(true);
	framed.output.flushFrame();
	expect(framed.written).toStrictEqual([
		'<a=T,i=1,m=1>',
		'<m=0>',
		'\u001B[1;1H',
		'row 1 ',
		'row 2',
	]);
});

test('the next image frame starts a new renderer frame, after the cells of the last', () => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1'), screen('cells 1')]);
	framed.output.receive([graphics('a=T,i=2'), screen('cells 2')]);
	framed.output.flushFrame();
	expect(framed.written).toStrictEqual(['<a=T,i=1>', 'cells 1']);

	framed.advance(4);
	framed.output.flushFrame();
	expect(framed.written.slice(2)).toStrictEqual(['<a=T,i=2>', 'cells 2']);
});

test('a program that never pauses still has its frame shown', () => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1'), screen('a')]);
	for (let read = 0; read < 20; read++) {
		framed.advance(3);
		framed.output.receive([screen('b')]);
	}

	framed.output.flushFrame();
	expect(framed.written.length > 0).toBe(true);
	expect(framed.written[0]).toBe('<a=T,i=1>');
});

test('a command the output has no room for waits for the next frame', () => {
	const written: string[] = [];
	let isFull = true;
	const output = new FramedOutput({
		writeScreen(bytes) {
			written.push(new TextDecoder().decode(bytes));
		},
		writeGraphics(commands) {
			if (isFull) return false;
			written.push(...commands.map(({command}) => command));
			return true;
		},
		requestFrame() {},
		schedule(callback) {
			callback();
			return () => {};
		},
	});
	output.receive([graphics('a=T,i=1'), screen('cells')]);
	output.flushFrame();
	expect(written).toStrictEqual([]);
	isFull = false;
	output.flushFrame();
	expect(written.length).toBe(2);
	expect(written[1]).toBe('cells');
});

test("an upload's chunks go out in one passthrough sequence, split only past the size limit", () => {
	const written: string[] = [];
	const forwarder = new GraphicsForwarder(
		sequence => {
			written.push(sequence);
			return true;
		},
		true,
		120,
	);
	forwarder.probe();
	written.length = 0;
	forwarder.readReplies(`${ESC}_Gi=31341;OK${ESC}\\`);
	const first = `${ESC}_Ga=T,i=7,m=1;${'A'.repeat(40)}${ESC}\\`;
	const last = `${ESC}_Gm=0;${'A'.repeat(40)}${ESC}\\`;
	forwarder.forward(first, last);
	expect(written).toStrictEqual([wrapForTmux(first + last, 1)]);

	written.length = 0;
	forwarder.forward(first, first, last);
	expect(written).toStrictEqual([
		wrapForTmux(first + first, 1),
		wrapForTmux(last, 1),
	]);
	forwarder.dispose();
});

test('an upload slower than the hold is not given to the renderer until its last chunk', () => {
	const framed = framedOutput();
	framed.output.receive([screen('before'), graphics('a=T,i=1,m=1')]);
	framed.advance(60);
	framed.output.flushFrame();
	expect(framed.written).toStrictEqual(['before']);

	framed.output.receive([graphics('m=0'), screen('cells')]);
	framed.advance(4);
	framed.output.flushFrame();
	expect(framed.written).toStrictEqual([
		'before',
		'<a=T,i=1,m=1>',
		'<m=0>',
		'cells',
	]);
});

test('an upload whose last chunk never comes stops holding the output after a second', () => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1,m=1'), screen('text')]);
	framed.advance(1000);
	framed.output.flushFrame();
	expect(framed.written).toStrictEqual(['<a=T,i=1,m=1>', 'text']);
});
