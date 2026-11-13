import test from 'ava';
import {
	FramedOutput,
	GraphicsForwarder,
	wrapForTmux,
} from './pane-frame-graphics.ts';

const ESC = '\u001B';
const command = `${ESC}_Ga=d,d=I,i=7,q=2${ESC}\\`;

test('each tmux layer gets its own passthrough, with escapes doubled', t => {
	t.is(wrapForTmux(command, 0), command);
	t.is(
		wrapForTmux(command, 1),
		`${ESC}Ptmux;${ESC}${ESC}_Ga=d,d=I,i=7,q=2${ESC}${ESC}\\${ESC}\\`,
	);
	t.is(
		wrapForTmux(command, 2),
		`${ESC}Ptmux;${ESC}${ESC}Ptmux;${ESC}${ESC}${ESC}${ESC}_Ga=d,d=I,i=7,q=2${ESC}${ESC}${ESC}${ESC}\\${ESC}${ESC}\\${ESC}\\`,
	);
});

test('outside tmux a command is written as it came', t => {
	const written: string[] = [];
	const forwarder = new GraphicsForwarder(
		sequence => written.push(sequence),
		false,
	);
	forwarder.probe();
	forwarder.forward(command);
	t.deepEqual(written, [command]);
});

test('inside tmux commands wait for the probe, then go out wrapped for the depth that answered', t => {
	const written: string[] = [];
	const forwarder = new GraphicsForwarder(
		sequence => written.push(sequence),
		true,
	);
	forwarder.probe();
	const probes = written.splice(0);
	t.is(probes.length, 1);
	t.true(probes[0]!.includes('i=31342'));

	forwarder.forward(command);
	t.deepEqual(written, []);
	forwarder.readReplies(`${ESC}_Gi=65537;OK${ESC}\\${ESC}_Gi=31342;OK${ESC}\\`);
	t.deepEqual(written, [wrapForTmux(command, 2)]);

	forwarder.forward(command);
	t.deepEqual(written.at(-1), wrapForTmux(command, 2));
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
		writeGraphics(command) {
			written.push(`<${command.slice(3).split(';')[0]!}>`);
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

test('output with no graphics before it goes to the screen at once', t => {
	const framed = framedOutput();
	framed.output.receive([screen('hello')]);
	t.deepEqual(framed.written, ['hello']);
	t.is(framed.frameRequests, 0);
});

test('an image frame arriving over several reads reaches one renderer frame whole', t => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1,m=1'), screen('\u001B[1;1H')]);
	framed.output.receive([graphics('m=0'), screen('row 1 ')]);
	framed.output.receive([screen('row 2')]);
	framed.output.flushFrame();
	t.deepEqual(framed.written, [], 'nothing is drawn before the program pauses');

	framed.advance(4);
	t.true(framed.frameRequests > 0);
	framed.output.flushFrame();
	t.deepEqual(framed.written, [
		'<a=T,i=1,m=1>',
		'\u001B[1;1H',
		'<m=0>',
		'row 1 ',
		'row 2',
	]);
});

test('the next image frame starts a new renderer frame, after the cells of the last', t => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1'), screen('cells 1')]);
	framed.output.receive([graphics('a=T,i=2'), screen('cells 2')]);
	framed.output.flushFrame();
	t.deepEqual(framed.written, ['<a=T,i=1>', 'cells 1']);

	framed.advance(4);
	framed.output.flushFrame();
	t.deepEqual(framed.written.slice(2), ['<a=T,i=2>', 'cells 2']);
});

test('a program that never pauses still has its frame shown', t => {
	const framed = framedOutput();
	framed.output.receive([graphics('a=T,i=1'), screen('a')]);
	for (let read = 0; read < 20; read++) {
		framed.advance(3);
		framed.output.receive([screen('b')]);
	}

	framed.output.flushFrame();
	t.true(framed.written.length > 0);
	t.is(framed.written[0], '<a=T,i=1>');
});

test('a command the output has no room for waits for the next frame', t => {
	const written: string[] = [];
	let isFull = true;
	const output = new FramedOutput({
		writeScreen(bytes) {
			written.push(new TextDecoder().decode(bytes));
		},
		writeGraphics(command) {
			if (isFull) return false;
			written.push(command);
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
	t.deepEqual(written, []);
	isFull = false;
	output.flushFrame();
	t.is(written.length, 2);
	t.is(written[1], 'cells');
});
