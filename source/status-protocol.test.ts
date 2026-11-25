import {test, expect} from 'bun:test';
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

test('every client message is read back as it was written', () => {
	const messages: ClientMessage[] = [
		{type: 'hook', state: {...hookState('repo-A'), currentTool: 'Bash'}},
		{type: 'restore', state: hookState('repo-A')},
		{type: 'snapshot', snapshot},
		{type: 'forget', repo: 'repo', key: 'A', keep: 'g1'},
		{type: 'forget', repo: 'repo', key: 'A'},
		{type: 'forget', repo: 'repo', key: 'A', keep: 'g1', generations: ['g0']},
		{type: 'drop', repo: 'repo', key: 'A', generation: 'g1'},
		{type: 'subscribe', repo: 'repo'},
	];
	for (const message of messages)
		expect(parseClientMessage(encodeMessage(message).trimEnd())).toStrictEqual({
			kind: 'message',
			message,
		});
});

test('every daemon message is read back as it was written', () => {
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
		{type: 'dropped', repo: 'repo', key: 'A', generation: 'g1'},
	];
	for (const message of messages)
		expect(parseDaemonMessage(encodeMessage(message).trimEnd())).toStrictEqual({
			kind: 'message',
			message,
		});
});

test('a forget that names no pane generations reads as one without the field', () => {
	expect(
		parseClientMessage(
			line({type: 'forget', repo: 'repo', key: 'A', generations: []}),
		),
	).toStrictEqual({
		kind: 'message',
		message: {type: 'forget', repo: 'repo', key: 'A'},
	});
});

test('a line that is not a message is invalid, and reading it does not throw', () => {
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
		line({type: 'forget', repo: 'repo', key: 'A', generations: 'g0'}),
		line({type: 'forget', repo: 'repo', key: 'A', generations: ['g0', 5]}),
		line({type: 'subscribe'}),
	]) {
		expect(parseClientMessage(text), `line: ${text}`).toStrictEqual({
			kind: 'invalid',
		});
	}

	for (const text of [
		'not json',
		line({type: 'subscribe', repo: 'repo'}),
		line({type: 'state', hooks: [], snapshots: []}),
		line({type: 'state', daemon: 'daemon', hooks: [hookState('repo-A')]}),
		line({type: 'state', daemon: 'daemon', hooks: [{}], snapshots: []}),
		line({type: 'state', daemon: 'daemon', hooks: [], snapshots: [{}]}),
	]) {
		expect(parseDaemonMessage(text), `line: ${text}`).toStrictEqual({
			kind: 'invalid',
		});
	}
});

test('a line is handed over once its end has arrived, whatever the chunks', () => {
	const reader = new LineReader();
	expect(reader.feed('{"a"')).toStrictEqual([]);
	expect(reader.feed(':1}\n{"b":2}\n{"c"')).toStrictEqual([
		'{"a":1}',
		'{"b":2}',
	]);
	expect(reader.feed(':3}')).toStrictEqual([]);
	expect(reader.feed('\n')).toStrictEqual(['{"c":3}']);
});
