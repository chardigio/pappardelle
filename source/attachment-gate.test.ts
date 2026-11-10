import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {AttachmentGate} from './attachment-gate.ts';

const settled = async (promise: Promise<void>) => {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	await delay(0);
	return done;
};

test('a key for the space already attaching goes straight through', async t => {
	const gate = new AttachmentGate();
	gate.rendered('STA-1');
	t.true(await settled(gate.whenRendered('STA-1')));
});

test('a key for a space selected earlier in the same input write waits for its attachment', async t => {
	const gate = new AttachmentGate();
	gate.rendered('STA-1');
	const waiting = gate.whenRendered('STA-2');
	t.false(await settled(waiting));
	gate.rendered('STA-2');
	t.true(await settled(waiting));
});

test('moving on to another space releases the wait so the key can be refused', async t => {
	const gate = new AttachmentGate();
	const waiting = gate.whenRendered('STA-2');
	gate.rendered('STA-3');
	t.true(await settled(waiting));
});
