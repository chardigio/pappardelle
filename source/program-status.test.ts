import {Buffer} from 'node:buffer';
import test from 'ava';
import {
	parseProgramReport,
	ProgramStatusStore,
	TerminalStatusParser,
} from './program-status.ts';

const osc = (body: string, end = '\x1b\\') =>
	Buffer.from(`\x1b]7501;${body}${end}`);
const text = (value: string) => Buffer.from(value).toString('base64');

test('malformed pairs are skipped, unknown keys ignored and the last valid duplicate wins', t => {
	t.deepEqual(
		parseProgramReport(
			' state = working :bad:STATE=error:x=ok:state=blocked:kind=question:progress=42:app=claude-code',
		),
		{
			state: 'blocked',
			id: '',
			kind: 'question',
			progress: 42,
			app: 'claude-code',
		},
	);
	t.is(parseProgramReport('app=claude-code'), null);
	t.is(parseProgramReport('state=future'), null);
	t.deepEqual(parseProgramReport('state=done:kind=question:progress=30'), {
		state: 'done',
		id: '',
	});
	t.deepEqual(parseProgramReport('state=working:app=bad/name:progress=1.2'), {
		state: 'working',
		id: '',
	});
});

test('text validation rejects the whole report even when the invalid field is overwritten', t => {
	t.deepEqual(
		parseProgramReport(`state=working:msg=${text('héllo').replace(/=+$/, '')}`),
		{state: 'working', id: '', message: 'héllo'},
	);
	for (const value of [
		'a',
		'====',
		'/w==',
		text('bad\ntext'),
		text('\u0085'),
		text('\x7f'),
	]) {
		t.is(
			parseProgramReport(`state=working:msg=${value}:msg=${text('good')}`),
			null,
			`Invalid text ${value}`,
		);
	}
	t.is(parseProgramReport(`state=done:title=${text('x'.repeat(193))}`), null);
	t.is(parseProgramReport(`state=done:msg=${text('x'.repeat(2049))}`), null);
});

test('limits and id grammar are enforced before replacing any record', t => {
	for (const id of [
		'/',
		'a//b',
		'a/',
		'x'.repeat(33),
		Array.from({length: 9}, () => 'a').join('/'),
		Array.from({length: 5}, () => 'a'.repeat(32)).join('/'),
	]) {
		t.is(
			parseProgramReport(`state=working:id=${id}`),
			null,
			`Invalid id ${id}`,
		);
	}
	t.is(parseProgramReport(`state=done:${'x'.repeat(17)}=value`), null);
	t.is(parseProgramReport(`state=done:app=${'x'.repeat(33)}`), null);
	t.is(parseProgramReport(`state=done:${'x=value:'.repeat(600)}`), null);
});

test('complete sequence limits include the actual terminator and tmux wrapping', t => {
	for (const terminator of ['\x07', '\x1b\\']) {
		const prefix = '\x1b]7501;state=done:x=';
		const sequence =
			prefix +
			'a'.repeat(4096 - prefix.length - terminator.length) +
			terminator;
		const events: TerminalStatusEvent[] = [];
		const parser = new TerminalStatusParser(event => events.push(event));
		parser.feed(Buffer.from(sequence));
		parser.feed(Buffer.from(sequence.replace('state=done', 'state=donea')));
		parser.feed(
			Buffer.from(`\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`),
		);
		t.deepEqual(events, [
			{type: 'report', report: {state: 'done', id: ''}},
			{type: 'report', report: {state: 'done', id: ''}},
		]);
	}
});

test('reports replace records, children inherit app, and clearing follows segment boundaries', t => {
	const store = new ProgramStatusStore();
	store.apply(parseProgramReport('state=working:app=claude-code')!);
	store.apply(parseProgramReport('state=blocked:id=worker:kind=question')!);
	store.apply(parseProgramReport('state=done:id=worker/test')!);
	store.apply(parseProgramReport('state=error:id=workers')!);
	t.deepEqual(store.status(), {
		status: 'blocked',
		id: 'worker',
		app: 'claude-code',
		kind: 'question',
	});
	store.apply(parseProgramReport('state=working:id=worker')!);
	t.is(store.records().find(r => r.id === 'worker')?.kind, undefined);
	store.apply(parseProgramReport('state=clear:id=worker')!);
	t.deepEqual(
		store.records().map(r => r.id),
		['', 'workers'],
	);
	t.is(store.status().status, 'error');
	store.apply(parseProgramReport('state=clear')!);
	t.deepEqual(store.status(), {status: 'unknown'});
	t.true(store.authoritative);
});

test('blocked outranks error and working; ties prefer root then latest update', t => {
	const store = new ProgramStatusStore();
	for (const body of [
		'state=working',
		'state=error:id=x',
		'state=blocked:id=a',
		'state=blocked:id=b',
	])
		store.apply(parseProgramReport(body)!);
	t.is(store.status().id, 'b');
	store.apply(parseProgramReport('state=blocked')!);
	t.is(store.status().id, '');
});

test('prompt and process exit drop active records, not completion; no clock expiry', t => {
	const store = new ProgramStatusStore();
	for (const body of [
		'state=working',
		'state=blocked:id=a',
		'state=done:id=b',
		'state=error:id=c',
		'state=idle:id=d',
	])
		store.apply(parseProgramReport(body)!);
	store.processExit();
	t.deepEqual(
		store.records().map(r => r.id),
		['b', 'c', 'd'],
	);
	t.is(store.status().status, 'error');
	store.reset();
	t.true(store.authoritative);
	t.is(store.status().status, 'unknown');
});

test('record cap evicts the least recently updated record', t => {
	const store = new ProgramStatusStore();
	for (let i = 0; i < 256; i++)
		store.apply(parseProgramReport(`state=working:id=r${i}`)!);
	store.apply(parseProgramReport('state=done:id=r0')!);
	store.apply(parseProgramReport('state=done:id=new')!);
	t.is(store.records().length, 256);
	t.true(store.records().some(r => r.id === 'r0'));
	t.false(store.records().some(r => r.id === 'r1'));
});

test('streaming parser handles every byte boundary and both terminators', t => {
	for (const end of ['\x07', '\x1b\\']) {
		const input = Buffer.concat([
			Buffer.from('screen output'),
			osc('state=working', end),
			osc('state=blocked:kind=auth', end),
		]);
		for (let i = 0; i <= input.length; i++) {
			const events: string[] = [];
			const parser = new TerminalStatusParser(event =>
				events.push(event.type === 'report' ? event.report.state : event.type),
			);
			parser.feed(input.subarray(0, i));
			parser.feed(input.subarray(i));
			t.deepEqual(events, ['working', 'blocked']);
		}
	}
});

test('queries, shell prompts, full resets and tmux passthrough are parsed; other strings are opaque', t => {
	const events: string[] = [];
	const parser = new TerminalStatusParser(event => events.push(event.type));
	parser.feed(
		Buffer.concat([
			osc('?'),
			Buffer.from('\x1b]133;A;redraw=0\x07\x1bc'),
			Buffer.from('\x1b[!p\x1b[?1049h'),
		]),
	);
	parser.feed(Buffer.from('\x1bPopaque\x1b]7501;state=error\x07\x1b\\'));
	parser.feed(
		Buffer.from('\x1bPtmux;\x1b\x1b]7501;state=done\x1b\x1b\\\x1b\\'),
	);
	t.deepEqual(events, ['query', 'prompt', 'reset', 'report']);
});

test('cancellation and oversized streams recover without retaining screen output', t => {
	const reports: string[] = [];
	const parser = new TerminalStatusParser(event => {
		if (event.type === 'report') reports.push(event.report.state);
	});
	parser.feed(Buffer.from('\x1b]7501;state=error\x18'));
	parser.feed(Buffer.from(`\x1b]7501;msg=${'a'.repeat(20000)}\x07`));
	parser.feed(Buffer.from(`\x1b]7501;state=error\x1b]7501;state=done\x07`));
	parser.feed(Buffer.alloc(100000, 65));
	t.deepEqual(reports, ['done']);
	t.is(parser.bufferedBytes, 0);
});
