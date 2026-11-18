import test from 'ava';
import {parseStatusListing} from './program-status-monitor.ts';

const row = (
	session: string,
	active: string,
	pinned: string,
	id: string,
	pid: string,
	piped = '0',
) => [session, active, pinned, id, pid, '0', piped, ''].join('\t');

test('an unpinned session’s pane is its current pane', t => {
	const panes = parseStatusListing(
		[
			row('agent', '0', '', '%1', '10'),
			row('agent', '0', '', '%2', '11'),
			row('agent', '1', '', '%3', '12'),
			row('agent', '0', '', '%4', '13'),
		].join('\n'),
		'socket',
	);
	t.is(panes.get('agent')?.pinned, '');
	t.is(panes.get('agent')?.pane?.id, '%3');
});

test('a pinned session keeps its pinned pane wherever the focus moved', t => {
	const panes = parseStatusListing(
		[
			row('agent', '0', '%1', '%1', '10', '1'),
			row('agent', '1', '%1', '%2', '11'),
		].join('\n'),
		'socket',
	);
	t.like(panes.get('agent'), {pinned: '%1', pane: {id: '%1', piped: true}});
});

test('a pinned pane that no longer exists locates nothing', t => {
	const panes = parseStatusListing(
		row('agent', '1', '%9', '%2', '11'),
		'socket',
	);
	t.is(panes.get('agent')?.pane, null);
});

test('sessions are located independently and missing sessions are absent', t => {
	const panes = parseStatusListing(
		[
			row('one', '1', '', '%1', '10'),
			row('two', '1', '%2', '%2', '11', '1'),
			'',
		].join('\n'),
		'socket',
	);
	t.is(panes.get('one')?.pane?.id, '%1');
	t.is(panes.get('two')?.pane?.id, '%2');
	t.false(panes.has('three'));
	t.is(panes.size, 2);
});
