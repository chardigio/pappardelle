// Pappardelle's panes in the Herdr desktop window.
//
// The desktop app models panes differently from both tmux and the `herdr` CLI:
//
//   tmux / herdr CLI   a pane is a *viewer*. It runs `tmux attach` or
//                      `hc attach`, and showing another space means typing
//                      another command into it.
//   Herdr desktop      a pane *owns* a terminal: the one `pane.split` made
//                      for it. But `terminal.show` displays *another*
//                      terminal in that pane "for now", and the shown
//                      terminal takes the keys. That is the same viewer
//                      semantics tmux has, so switching space means showing
//                      that space's terminals in the panes that are already
//                      there -- not selecting a tab.
//
// What does *not* work is the earlier design: it relied on a space's tab being
// selected to show its panes, which put the rail in a tab of its own and left
// the person looking at an agent and companion with no rail beside them. The
// three panes belong in one tab, like tmux's window.
//
// So this module deals in one tab: the one holding the rail. The rail's own
// pane is split right twice, and each space's agent and companion are core
// terminals with no pane of their own (unlabelled, so the window does not
// adopt them into a tab behind the person's back) shown in those two panes.

import {createLogger} from '../logger.ts';
import {answerField, doCommand, listSpaces, type AppSpace} from './app.ts';
import {
	findTerminalsByLabels,
	VIEWER_LABEL,
	VIEWER_ROLE_LABEL,
} from './terminals.ts';

const log = createLogger('herdr-app-layout');

/** Where this process sits in the desktop window. */
export type AppLocation = {
	spaceId: string;
	tabId: string;
	paneId: string;
};

/**
 * The space and tab whose pane holds this process, found by matching
 * `HC_TERMINAL_ID` against the window's listing.
 *
 * Null when the app is not running, or when this process runs outside it --
 * which is the signal to use another backend instead of guessing.
 */
export async function locateInApp(
	terminalId: string | undefined = process.env['HC_TERMINAL_ID'],
): Promise<AppLocation | null> {
	if (!terminalId) return null;

	let spaces: AppSpace[];
	try {
		spaces = await listSpaces();
	} catch {
		return null;
	}

	const found = findTerminalIn(spaces, terminalId);
	return found;
}

/** Where a terminal sits: its space, its tab and its pane. */
export function findTerminalIn(
	spaces: readonly AppSpace[],
	terminalId: string,
): AppLocation | null {
	for (const space of spaces) {
		for (const tab of space.tabs) {
			for (const terminal of tab.terminals) {
				if (terminal.terminal === terminalId) {
					return {spaceId: space.id, tabId: tab.id, paneId: terminal.pane};
				}
			}
		}
	}

	return null;
}

/** The space with this id, from a listing. */
export function findSpace(
	spaces: readonly AppSpace[],
	spaceId: string,
): AppSpace | undefined {
	return spaces.find(space => space.id === spaceId);
}

/** The pane ids of the tab holding a terminal, in the window's order. */
export function panesOfTab(
	spaces: readonly AppSpace[],
	terminalId: string,
): string[] {
	const location = findTerminalIn(spaces, terminalId);
	if (!location) return [];
	const tab = findSpace(spaces, location.spaceId)?.tabs.find(
		candidate => candidate.id === location.tabId,
	);
	return tab ? tab.terminals.map(terminal => terminal.pane) : [];
}

/** Where a terminal is drawn: its pane, and the space and tab holding it. */
export function paneHoldingTerminal(
	spaces: readonly AppSpace[],
	terminalId: string,
): {paneId: string; spaceId: string; tabId: string} | null {
	return findTerminalIn(spaces, terminalId);
}

/**
 * The rail's own viewer panes, found by the label `pane.split` put on them.
 *
 * The pane itself carries no mark saying who made it, so a relaunch cannot tell
 * its own viewers from a pane the person split in the same tab. The label does:
 * each viewer terminal names the rail that made it, so these are Pappardelle's
 * panes and nobody else's.
 */
export async function findViewerPanes(
	railTerminal: string,
): Promise<{agent: string; companion: string}> {
	const viewers = await findTerminalsByLabels({[VIEWER_LABEL]: railTerminal});
	const spaces = await listSpaces();
	return viewerPanesAmong(viewers, address =>
		paneHoldingTerminal(spaces, address),
	);
}

/**
 * The pane ids of the labelled viewers, by role.
 *
 * Separated from the listing calls so the rule that matters -- a labelled
 * terminal only counts if the window is still drawing it in a pane -- is
 * checkable without a live window. An empty id means the role has no viewer,
 * which the caller answers by making one.
 */
export function viewerPanesAmong(
	viewers: ReadonlyArray<{address: string; labels: Record<string, string>}>,
	locate: (terminalId: string) => {paneId: string} | null,
): {agent: string; companion: string} {
	const paneOf = (role: string): string => {
		const viewer = viewers.find(
			candidate => candidate.labels[VIEWER_ROLE_LABEL] === role,
		);
		if (!viewer) return '';
		return locate(viewer.address)?.paneId ?? '';
	};

	return {agent: paneOf('agent'), companion: paneOf('companion')};
}

/**
 * Split a pane, returning the new pane and the terminal it came with.
 *
 * The new pane comes with a terminal of its own, which is what the window
 * draws until something is shown in it. That terminal is what carries the
 * viewer label, so it is returned with the pane.
 */
export async function splitPaneInApp(
	paneId: string,
	direction: 'right' | 'down' = 'right',
): Promise<{paneId: string; terminalId: string} | null> {
	try {
		const answer = await doCommand('pane.split', {
			pane: paneId,
			direction,
		});
		const newPane = answerField(answer, 'pane');
		const newTerminal = answerField(answer, 'terminal');
		return newPane && newTerminal
			? {paneId: newPane, terminalId: newTerminal}
			: null;
	} catch (error) {
		log.error(
			`Could not split pane ${paneId}`,
			error instanceof Error ? error : undefined,
		);
		return null;
	}
}

/**
 * Show a terminal in a pane, in place of the pane's own.
 *
 * This is the desktop equivalent of `tmux attach` in a viewer pane: the shown
 * terminal takes the keys, and it stays shown across tab and space switches
 * until another `terminal.show` replaces it.
 */
export async function showTerminalInPane(
	terminalId: string,
	paneId: string,
): Promise<boolean> {
	try {
		await doCommand('terminal.show', {terminal: terminalId, pane: paneId});
		return true;
	} catch (error) {
		log.warn(
			`Could not show ${terminalId} in pane ${paneId}`,
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

/** Focus a pane, which is how the desktop backend puts the keyboard in it. */
export async function focusPaneInApp(paneId: string): Promise<void> {
	await doCommand('pane.focus', {pane: paneId});
}

/**
 * Give a pane a share of its row. `layout.resize` takes a `weight`: the
 * panes of a row split its width in proportion to their weights, so the shape
 * holds at any window size.
 */
export async function sizePaneInApp(
	paneId: string,
	weight: number,
): Promise<boolean> {
	try {
		await doCommand('layout.resize', {id: paneId, weight});
		return true;
	} catch (error) {
		log.warn(
			`Could not weight pane ${paneId} at ${weight}`,
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

/**
 * The rail's three columns at 1/4 : 1/2 : 1/4, as weights 1 : 2 : 1.
 *
 * `pane.split` halves its source, so splitting twice leaves the widths at
 * {1/2, 1/4, 1/4} with the half at an edge, and swapping moves terminals
 * between those slots without moving the widths. `layout.resize` sets them.
 */
export function railColumnWidths(layout: {
	listPaneId: string;
	agentViewerPaneId: string;
	companionViewerPaneId: string;
}): Array<{paneId: string; weight: number}> {
	const widths = [{paneId: layout.listPaneId, weight: 1}];
	if (layout.agentViewerPaneId) {
		widths.push({paneId: layout.agentViewerPaneId, weight: 2});
	}

	if (layout.companionViewerPaneId) {
		widths.push({paneId: layout.companionViewerPaneId, weight: 1});
	}

	return widths;
}

/**
 * Size the rail's three columns at 1/4 : 1/2 : 1/4.
 *
 * Called when the layout is first built and again whenever a space is shown,
 * since showing one does not touch the widths and a person may have dragged
 * the dividers.
 */
export async function sizeRailColumnsInApp(layout: {
	listPaneId: string;
	agentViewerPaneId: string;
	companionViewerPaneId: string;
}): Promise<void> {
	for (const {paneId, weight} of railColumnWidths(layout)) {
		await sizePaneInApp(paneId, weight);
	}
}

/** Close a pane the rail split off. */
export async function closePaneInApp(paneId: string): Promise<void> {
	await doCommand('pane.close', {pane: paneId});
}

/** Show a space and a tab, which is how the rail brings its window forward. */
export async function selectSpaceTab(
	spaceId: string,
	tabId: string,
): Promise<boolean> {
	try {
		await doCommand('space.select', {id: spaceId});
		await doCommand('tab.select', {id: tabId});
		return true;
	} catch (error) {
		log.warn(
			`Could not show space ${spaceId}, tab ${tabId}`,
			error instanceof Error ? error : undefined,
		);
		return false;
	}
}

/** Name the tab the panes live in, so the window's strip reads like the rail. */
export async function nameTab(tabId: string, name: string): Promise<void> {
	await doCommand('tab.rename', {id: tabId, name}).catch(() => undefined);
}
