import test from 'ava';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {hookState, testPane} from '../test/helpers/status-daemon.ts';
import {
	LineReader,
	encodeMessage,
	parseClientMessage,
	parseDaemonMessage,
	type ClientMessage,
	type DaemonMessage,
} from './status-protocol.ts';

const snapshot = snapshotOf({repo: 'repo', key: 'A', pane: testPane('g1')}, []);
const line = (value: unknown) => JSON.stringify(value);

test('every client message is read back as it was written', t => {
	const messages: ClientMessage[] = [
		{type: 'hook', state: {...hookState('repo-A'), currentTool: 'Bash'}},
		{type: 'restore', state: hookState('repo-A')},
		{type: 'snapshot', snapshot},
		{type: 'forget', repo: 'repo', key: 'A', keep: 'g1'},
		{type: 'forget', repo: 'repo', key: 'A'},
		{type: 'subscribe', repo: 'repo'},
	];
	for (const message of messages)
		t.deepEqual(parseClientMessage(encodeMessage(message).trimEnd()), {
			kind: 'message',
			message,
		});
});

test('every daemon message is read back as it was written', t => {
	const messages: DaemonMessage[] = [
		{
			type: 'state',
			daemon: 'daemon',
			hooks: [hookState('repo-A')],
			snapshots: [snapshot],
		},
		{type: 'hook', state: hookState('repo-A')},
		{type: 'snapshot', snapshot},
		{type: 'forgotten', repo: 'repo', key: 'A', keep: 'g1'},
	];
	for (const message of messages)
		t.deepEqual(parseDaemonMessage(encodeMessage(message).trimEnd()), {
			kind: 'message',
			message,
		});
});

test('a line that is not a message is invalid, and reading it does not throw', t => {
	for (const text of [
		'',
		'not json',
		'null',
		'5',
		'[]',
		line({type: 'unknown'}),
		line({type: 'hook'}),
		line({type: 'hook', state: {...hookState('repo-A'), status: 'napping'}}),
		line({type: 'hook', state: {...hookState('repo-A'), sessionId: 5}}),
		line({type: 'snapshot', snapshot: {...snapshot, pane: null}}),
		line({type: 'snapshot', snapshot: {...snapshot, repo: undefined}}),
		line({type: 'forget', repo: 'repo'}),
		line({type: 'forget', repo: 'repo', key: 'A', keep: 5}),
		line({type: 'subscribe'}),
	]) {
		t.deepEqual(parseClientMessage(text), {kind: 'invalid'}, `line: ${text}`);
	}

	for (const text of [
		'not json',
		line({type: 'subscribe', repo: 'repo'}),
		line({type: 'state', hooks: [], snapshots: []}),
		line({type: 'state', daemon: 'daemon', hooks: [hookState('repo-A')]}),
		line({type: 'state', daemon: 'daemon', hooks: [{}], snapshots: []}),
		line({type: 'state', daemon: 'daemon', hooks: [], snapshots: [{}]}),
	]) {
		t.deepEqual(parseDaemonMessage(text), {kind: 'invalid'}, `line: ${text}`);
	}
});

test('a line is handed over once its end has arrived, whatever the chunks', t => {
	const reader = new LineReader();
	t.deepEqual(reader.feed('{"a"'), []);
	t.deepEqual(reader.feed(':1}\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
	t.deepEqual(reader.feed(':3}'), []);
	t.deepEqual(reader.feed('\n'), ['{"c":3}']);
});
