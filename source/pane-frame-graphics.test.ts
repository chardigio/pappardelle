import test from 'ava';
import {GraphicsForwarder, wrapForTmux} from './pane-frame-graphics.ts';

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
