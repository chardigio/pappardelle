import test from 'ava';
import {
	createMessageDecoder,
	encodeMessage,
	type ChildMessage,
} from './protocol.ts';

test('a message split across chunks arrives once, whole', t => {
	const received: ChildMessage[] = [];
	const decode = createMessageDecoder<ChildMessage>(message => {
		received.push(message);
	});
	const wire = encodeMessage({
		type: 'submit',
		submission: {prompt: 'fix it', profileName: null, inputIsIssueKey: false},
	});

	decode(wire.slice(0, 7));
	t.deepEqual(received, []);
	decode(wire.slice(7));
	t.deepEqual(received, [
		{
			type: 'submit',
			submission: {prompt: 'fix it', profileName: null, inputIsIssueKey: false},
		},
	]);
});

test('several messages in one chunk arrive in order', t => {
	const received: string[] = [];
	const decode = createMessageDecoder<ChildMessage>(message => {
		received.push(message.type);
	});

	decode(encodeMessage({type: 'confirm'}) + encodeMessage({type: 'cancel'}));
	t.deepEqual(received, ['confirm', 'cancel']);
});

test('lines that are not typed JSON messages are skipped', t => {
	const received: string[] = [];
	const decode = createMessageDecoder<ChildMessage>(message => {
		received.push(message.type);
	});

	decode('not json\n{"no":"type"}\n\n' + encodeMessage({type: 'cancel'}));
	t.deepEqual(received, ['cancel']);
});
