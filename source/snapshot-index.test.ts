import test from 'ava';
import {snapshotOf} from '../test/helpers/program-status.ts';
import {testPane} from '../test/helpers/status-daemon.ts';
import {SnapshotIndex} from './snapshot-index.ts';

const snapshot = (key: string, generation: string) =>
	snapshotOf({repo: 'repo', key, pane: testPane(generation)}, []);

test('a space whose last pane generation is dropped is no longer listed', t => {
	const index = new SnapshotIndex();
	index.keep(snapshot('A', 'g1'));
	index.keep(snapshot('A', 'g2'));
	index.keep(snapshot('B', 'g1'));

	index.drop('A', 'g1');
	t.deepEqual(index.keys(), ['A', 'B']);
	index.drop('A', 'g2');
	t.deepEqual(index.keys(), ['B']);
});
