import {test, expect} from 'bun:test';
import {parseStatusListing} from './program-status-monitor.ts';

const row = (
	session: string,
	active: string,
	pinned: string,
	id: string,
	pid: string,
	piped = '0',
) => [session, active, pinned, id, pid, '0', piped, ''].join('\t');

test('an unpinned session’s pane is its current pane', () => {
	const panes = parseStatusListing(
		[
			row('agent', '0', '', '%1', '10'),
			row('agent', '0', '', '%2', '11'),
			row('agent', '1', '', '%3', '12'),
			row('agent', '0', '', '%4', '13'),
		].join('\n'),
		'socket',
	);
	expect(panes.get('agent')?.pinned).toBe('');
	expect(panes.get('agent')?.pane?.id).toBe('%3');
});

test('a pinned session keeps its pinned pane wherever the focus moved', () => {
	const panes = parseStatusListing(
		[
			row('agent', '0', '%1', '%1', '10', '1'),
			row('agent', '1', '%1', '%2', '11'),
		].join('\n'),
		'socket',
	);
	expect(panes.get('agent')).toMatchObject({
		pinned: '%1',
		pane: {id: '%1', piped: true},
	});
});

test('a pinned pane that no longer exists locates nothing', () => {
	const panes = parseStatusListing(
		row('agent', '1', '%9', '%2', '11'),
		'socket',
	);
	expect(panes.get('agent')?.pane).toBe(null);
});

test('sessions are located independently and missing sessions are absent', () => {
	const panes = parseStatusListing(
		[
			row('one', '1', '', '%1', '10'),
			row('two', '1', '%2', '%2', '11', '1'),
			'',
		].join('\n'),
		'socket',
	);
	expect(panes.get('one')?.pane?.id).toBe('%1');
	expect(panes.get('two')?.pane?.id).toBe('%2');
	expect(panes.has('three')).toBe(false);
	expect(panes.size).toBe(2);
});
