import {test, expect} from 'bun:test';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {hookState, testPane} from '../test/helpers/status-daemon.ts';
import {FORGOTTEN_GENERATIONS_PER_REPO, StatusHub} from './status-hub.ts';
import type {DaemonMessage} from './status-protocol.ts';

const snapshot = (repo: string, key: string, generation: string, at = 1) =>
	snapshotOf({repo, key, pane: testPane(generation)}, [], {updatedAt: at});

/** The state a new subscriber to `repo` is sent. */
function stateOf(hub: StatusHub<string>, repo: string) {
	const [delivery] = hub.receive('reader', {type: 'subscribe', repo});
	hub.disconnect('reader');
	return delivery!.message as Extract<DaemonMessage, {type: 'state'}>;
}

test('a hook record replaces the one under its status key', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('hook', {type: 'hook', state: hookState('repo-A')});
	hub.receive('hook', {type: 'hook', state: hookState('repo-B')});
	const latest = hookState('repo-A', 'waiting_for_input');
	hub.receive('hook', {type: 'hook', state: latest});

	expect(stateOf(hub, 'repo').hooks).toStrictEqual([
		latest,
		hookState('repo-B'),
	]);
});

test('a restored hook record fills a key the daemon holds nothing for, and never replaces one as recent', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('reader', {type: 'subscribe', repo: 'repo'});
	const latest = {
		...hookState('repo-A', 'waiting_for_approval'),
		lastUpdate: 2000,
	};
	hub.receive('hook', {type: 'hook', state: latest});

	expect(
		hub.receive('rail', {type: 'restore', state: hookState('repo-A')}),
	).toStrictEqual([]);
	expect(
		hub.receive('rail', {type: 'restore', state: hookState('repo-B')}),
	).toStrictEqual([
		{to: 'reader', message: {type: 'hook', state: hookState('repo-B')}},
	]);
	expect(stateOf(hub, 'repo').hooks).toStrictEqual([
		latest,
		hookState('repo-B'),
	]);
});

test('a snapshot is kept per repo, space and pane generation', () => {
	const hub = new StatusHub<string>('daemon');
	for (const sent of [
		snapshot('one', 'A', 'g1'),
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
		snapshot('two', 'A', 'g1'),
	])
		hub.receive('monitor', {type: 'snapshot', snapshot: sent});
	const newer = snapshot('one', 'A', 'g1', 2);
	hub.receive('monitor', {type: 'snapshot', snapshot: newer});

	expect(stateOf(hub, 'one').snapshots).toStrictEqual([
		newer,
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
	]);
	expect(stateOf(hub, 'two').snapshots).toStrictEqual([
		snapshot('two', 'A', 'g1'),
	]);
});

test('forget drops the snapshots of a space except the pane generation to keep', () => {
	const hub = new StatusHub<string>('daemon');
	for (const sent of [
		snapshot('one', 'A', 'g1'),
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
		snapshot('two', 'A', 'g1'),
	])
		hub.receive('monitor', {type: 'snapshot', snapshot: sent});

	hub.receive('tui', {type: 'forget', repo: 'one', key: 'A', keep: 'g2'});
	expect(stateOf(hub, 'one').snapshots).toStrictEqual([
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
	]);

	hub.receive('tui', {type: 'forget', repo: 'one', key: 'A'});
	expect(stateOf(hub, 'one').snapshots).toStrictEqual([
		snapshot('one', 'B', 'g1'),
	]);
	expect(stateOf(hub, 'two').snapshots).toStrictEqual([
		snapshot('two', 'A', 'g1'),
	]);
});

test('a snapshot of a pane generation a forget named is not kept or pushed, and the forget pushes only what subscribers apply', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('rail', {type: 'subscribe', repo: 'one'});

	expect(
		hub.receive('tui', {
			type: 'forget',
			repo: 'one',
			key: 'A',
			generations: ['g1'],
		}),
	).toStrictEqual([
		{to: 'rail', message: {type: 'forgotten', repo: 'one', key: 'A'}},
	]);
	expect(
		hub.receive('monitor', {
			type: 'snapshot',
			snapshot: snapshot('one', 'A', 'g1'),
		}),
	).toStrictEqual([]);
	hub.receive('monitor', {
		type: 'snapshot',
		snapshot: snapshot('two', 'A', 'g1'),
	});

	expect(stateOf(hub, 'one').snapshots).toStrictEqual([]);
	expect(stateOf(hub, 'two').snapshots).toStrictEqual([
		snapshot('two', 'A', 'g1'),
	]);
});

test('a repo remembers only its latest forgotten pane generations', () => {
	const hub = new StatusHub<string>('daemon');
	const generations = Array.from(
		{length: FORGOTTEN_GENERATIONS_PER_REPO + 1},
		(_, index) => `g${index}`,
	);
	hub.receive('tui', {type: 'forget', repo: 'one', key: 'A', generations});
	for (const generation of ['g0', 'g1'])
		hub.receive('monitor', {
			type: 'snapshot',
			snapshot: snapshot('one', 'A', generation),
		});

	expect(stateOf(hub, 'one').snapshots).toStrictEqual([
		snapshot('one', 'A', 'g0'),
	]);
});

test('drop removes one pane generation of a space, and pushes nothing when there was none to remove', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('rail', {type: 'subscribe', repo: 'one'});
	for (const sent of [snapshot('one', 'A', 'g1'), snapshot('one', 'A', 'g2')])
		hub.receive('monitor', {type: 'snapshot', snapshot: sent});
	const drop = {type: 'drop', repo: 'one', key: 'A', generation: 'g1'} as const;

	expect(hub.receive('monitor', drop)).toStrictEqual([
		{to: 'rail', message: {...drop, type: 'dropped'}},
	]);
	expect(stateOf(hub, 'one').snapshots).toStrictEqual([
		snapshot('one', 'A', 'g2'),
	]);
	expect(hub.receive('monitor', drop)).toStrictEqual([]);
});

test('a subscriber is pushed every hook record, and the snapshots and forgets of its repo only', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('rail-one', {type: 'subscribe', repo: 'one'});
	hub.receive('rail-two', {type: 'subscribe', repo: 'two'});

	const hook = {type: 'hook', state: hookState('one-A')} as const;
	expect(hub.receive('hook', hook)).toStrictEqual([
		{to: 'rail-one', message: hook},
		{to: 'rail-two', message: hook},
	]);

	const pushed = {
		type: 'snapshot',
		snapshot: snapshot('two', 'A', 'g1'),
	} as const;
	expect(hub.receive('monitor', pushed)).toStrictEqual([
		{to: 'rail-two', message: pushed},
	]);

	expect(
		hub.receive('rail-one', {
			type: 'forget',
			repo: 'two',
			key: 'A',
			keep: 'g1',
		}),
	).toStrictEqual([
		{
			to: 'rail-two',
			message: {type: 'forgotten', repo: 'two', key: 'A', keep: 'g1'},
		},
	]);
});

test('the state sent on subscribing holds what arrived before, and goes to the subscriber alone', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('earlier', {type: 'subscribe', repo: 'one'});
	hub.receive('hook', {type: 'hook', state: hookState('one-A')});
	hub.receive('monitor', {
		type: 'snapshot',
		snapshot: snapshot('one', 'A', 'g1'),
	});

	expect(hub.receive('rail', {type: 'subscribe', repo: 'one'})).toStrictEqual([
		{
			to: 'rail',
			message: {
				type: 'state',
				daemon: 'daemon',
				hooks: [hookState('one-A')],
				snapshots: [snapshot('one', 'A', 'g1')],
			},
		},
	]);
});

test('a subscriber that disconnected is sent nothing more', () => {
	const hub = new StatusHub<string>('daemon');
	hub.receive('rail', {type: 'subscribe', repo: 'one'});
	hub.disconnect('rail');

	expect(
		hub.receive('hook', {type: 'hook', state: hookState('one-A')}),
	).toStrictEqual([]);
});
