import test from 'ava';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {hookState, testPane} from '../test/helpers/status-daemon.ts';
import {StatusHub} from './status-hub.ts';
import type {DaemonMessage} from './status-protocol.ts';

const snapshot = (repo: string, key: string, generation: string, at = 1) =>
	snapshotOf({repo, key, pane: testPane(generation)}, [], {updatedAt: at});

/** The state a new subscriber to `repo` is sent. */
function stateOf(hub: StatusHub<string>, repo: string) {
	const [delivery] = hub.receive('reader', {type: 'subscribe', repo});
	hub.disconnect('reader');
	return delivery!.message as Extract<DaemonMessage, {type: 'state'}>;
}

test('a hook record replaces the one under its status key', t => {
	const hub = new StatusHub<string>();
	hub.receive('hook', {type: 'hook', state: hookState('repo-A')});
	hub.receive('hook', {type: 'hook', state: hookState('repo-B')});
	const latest = hookState('repo-A', 'waiting_for_input');
	hub.receive('hook', {type: 'hook', state: latest});

	t.deepEqual(stateOf(hub, 'repo').hooks, [latest, hookState('repo-B')]);
});

test('a restored hook record fills a key the daemon holds nothing for, and never replaces one as recent', t => {
	const hub = new StatusHub<string>();
	hub.receive('reader', {type: 'subscribe', repo: 'repo'});
	const latest = {
		...hookState('repo-A', 'waiting_for_approval'),
		lastUpdate: 2000,
	};
	hub.receive('hook', {type: 'hook', state: latest});

	t.deepEqual(
		hub.receive('rail', {type: 'restore', state: hookState('repo-A')}),
		[],
	);
	t.deepEqual(
		hub.receive('rail', {type: 'restore', state: hookState('repo-B')}),
		[{to: 'reader', message: {type: 'hook', state: hookState('repo-B')}}],
	);
	t.deepEqual(stateOf(hub, 'repo').hooks, [latest, hookState('repo-B')]);
});

test('a snapshot is kept per repo, space and pane generation', t => {
	const hub = new StatusHub<string>();
	for (const sent of [
		snapshot('one', 'A', 'g1'),
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
		snapshot('two', 'A', 'g1'),
	])
		hub.receive('monitor', {type: 'snapshot', snapshot: sent});
	const newer = snapshot('one', 'A', 'g1', 2);
	hub.receive('monitor', {type: 'snapshot', snapshot: newer});

	t.deepEqual(stateOf(hub, 'one').snapshots, [
		newer,
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
	]);
	t.deepEqual(stateOf(hub, 'two').snapshots, [snapshot('two', 'A', 'g1')]);
});

test('forget drops the snapshots of a space except the pane generation to keep', t => {
	const hub = new StatusHub<string>();
	for (const sent of [
		snapshot('one', 'A', 'g1'),
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
		snapshot('two', 'A', 'g1'),
	])
		hub.receive('monitor', {type: 'snapshot', snapshot: sent});

	hub.receive('tui', {type: 'forget', repo: 'one', key: 'A', keep: 'g2'});
	t.deepEqual(stateOf(hub, 'one').snapshots, [
		snapshot('one', 'A', 'g2'),
		snapshot('one', 'B', 'g1'),
	]);

	hub.receive('tui', {type: 'forget', repo: 'one', key: 'A'});
	t.deepEqual(stateOf(hub, 'one').snapshots, [snapshot('one', 'B', 'g1')]);
	t.deepEqual(stateOf(hub, 'two').snapshots, [snapshot('two', 'A', 'g1')]);
});

test('a subscriber is pushed every hook record, and the snapshots and forgets of its repo only', t => {
	const hub = new StatusHub<string>();
	hub.receive('rail-one', {type: 'subscribe', repo: 'one'});
	hub.receive('rail-two', {type: 'subscribe', repo: 'two'});

	const hook = {type: 'hook', state: hookState('one-A')} as const;
	t.deepEqual(hub.receive('hook', hook), [
		{to: 'rail-one', message: hook},
		{to: 'rail-two', message: hook},
	]);

	const pushed = {
		type: 'snapshot',
		snapshot: snapshot('two', 'A', 'g1'),
	} as const;
	t.deepEqual(hub.receive('monitor', pushed), [
		{to: 'rail-two', message: pushed},
	]);

	t.deepEqual(
		hub.receive('rail-one', {
			type: 'forget',
			repo: 'two',
			key: 'A',
			keep: 'g1',
		}),
		[
			{
				to: 'rail-two',
				message: {type: 'forgotten', repo: 'two', key: 'A', keep: 'g1'},
			},
		],
	);
});

test('the state sent on subscribing holds what arrived before, and goes to the subscriber alone', t => {
	const hub = new StatusHub<string>();
	hub.receive('earlier', {type: 'subscribe', repo: 'one'});
	hub.receive('hook', {type: 'hook', state: hookState('one-A')});
	hub.receive('monitor', {
		type: 'snapshot',
		snapshot: snapshot('one', 'A', 'g1'),
	});

	t.deepEqual(hub.receive('rail', {type: 'subscribe', repo: 'one'}), [
		{
			to: 'rail',
			message: {
				type: 'state',
				hooks: [hookState('one-A')],
				snapshots: [snapshot('one', 'A', 'g1')],
			},
		},
	]);
});

test('a subscriber that disconnected is sent nothing more', t => {
	const hub = new StatusHub<string>();
	hub.receive('rail', {type: 'subscribe', repo: 'one'});
	hub.disconnect('rail');

	t.deepEqual(
		hub.receive('hook', {type: 'hook', state: hookState('one-A')}),
		[],
	);
});
