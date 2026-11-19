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

/**
 * The panes of the tab holding `terminalId`, except the one it is in.
 *
 * These are the viewer panes: they were split off the rail's pane on an
 * earlier run, and they survive relaunches because a pane outlives the
 * process that made it.
 */
export function viewerPanesOf(
	spaces: readonly AppSpace[],
	terminalId: string,
): string[] {
	const location = findTerminalIn(spaces, terminalId);
	if (!location) return [];
	const tab = findSpace(spaces, location.spaceId)?.tabs.find(
		candidate => candidate.id === location.tabId,
	);
	if (!tab) return [];
	return tab.terminals
		.filter(terminal => terminal.terminal !== terminalId)
		.map(terminal => terminal.pane);
}

/**
 * Split a pane, returning the new pane's id.
 *
 * The new pane comes with a terminal of its own, which is what the window
 * draws until something is shown in it.
 */
export async function splitPaneInApp(
	paneId: string,
	direction: 'right' | 'down' = 'right',
): Promise<string | null> {
	try {
		const answer = await doCommand('pane.split', {
			pane: paneId,
			direction,
		});
		return answerField(answer, 'pane') ?? null;
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
