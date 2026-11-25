import {test, expect} from 'bun:test';
import {orphanedViewerPanes} from './tmux.ts';

const frame = '/opt/pappardelle --internal-pane-frame --title agent --await';

function listing(rows: string[][]): string {
	return rows.map(row => row.join('\t')).join('\n');
}

test('viewer panes of a killed rail in the same window are orphans', () => {
	const panes = listing([
		['@1', '%1', 'agent · main', frame],
		['@1', '%2', 'companion', frame],
		['@1', '%5', 'rail', 'pappardelle'],
		['@1', '%6', 'agent', frame],
		['@1', '%7', 'companion', frame],
	]);
	expect(orphanedViewerPanes(panes, '%5', ['%6', '%7'])).toStrictEqual([
		'%1',
		'%2',
	]);
});

test('viewer panes in a window with no rail are orphans', () => {
	const panes = listing([
		['@1', '%1', 'agent · main', frame],
		['@2', '%5', 'rail', 'pappardelle'],
		['@2', '%6', 'agent', frame],
	]);
	expect(orphanedViewerPanes(panes, '%5', ['%6'])).toStrictEqual(['%1']);
});

test("another rail's viewer panes and the user's own panes are left alone", () => {
	const panes = listing([
		['@1', '%1', 'rail', 'pappardelle'],
		['@1', '%2', 'agent · main', frame],
		['@2', '%5', 'rail', 'pappardelle'],
		['@2', '%6', 'agent', frame],
		['@2', '%8', '', 'zsh'],
		['@3', '%9', '', 'nvim'],
	]);
	expect(orphanedViewerPanes(panes, '%5', ['%6'])).toStrictEqual([]);
});
