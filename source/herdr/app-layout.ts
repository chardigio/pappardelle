// Pappardelle's panes in the Herdr desktop window.
//
// The desktop app models panes differently from both tmux and the `herdr` CLI:
//
//   tmux / herdr CLI   a pane is a *viewer*. It runs `tmux attach` or
//                      `hc attach`, and showing another space means typing
//                      another command into it.
//   Herdr desktop      a pane *is* a terminal, and the window arranges panes
//                      itself. It also *adopts* any core terminal carrying
//                      `herdr.space=<id>` and `herdr.tab=<id>`: that terminal
//                      appears as a pane in that tab, with no command run and
//                      no attach typed.
//
// Adoption is the whole integration. Pappardelle starts a space's agent and
// companion as ordinary core terminals (exactly what the `herdr` backend does)
// and labels them into a tab. The window draws them. There is no layout maths,
// no ratio, and nothing to reattach when the selection changes: selecting a
// tab shows its panes.
//
// So this module deals in spaces and tabs, not pane ids.

import {createLogger} from '../logger.ts';
import {
	answerField,
	doCommand,
	listSpaces,
	type AppSpace,
	type AppTab,
} from './app.ts';

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

/** The tab and space holding a terminal, from a listing. */
export function findTerminalTab(
	spaces: readonly AppSpace[],
	terminalId: string,
): {space: AppSpace; tab: AppTab} | null {
	const location = findTerminalIn(spaces, terminalId);
	if (!location) return null;
	const space = findSpace(spaces, location.spaceId);
	const tab = space?.tabs.find(candidate => candidate.id === location.tabId);
	return space && tab ? {space, tab} : null;
}

/**
 * The labels a terminal needs for the window to show it in `spaceId`/`tabId`.
 *
 * These are the app's own adoption labels; the window does the rest.
 */
export function adoptionLabels(
	spaceId: string,
	tabId: string,
): Record<string, string> {
	return {'herdr.space': spaceId, 'herdr.tab': tabId};
}

/**
 * Make a space and a tab for it, returning their ids.
 *
 * The rail cannot call this for itself: it is already a pane in some tab, and
 * creating a space would move the person's window. It is here for a space that
 * needs a home the window has not made yet.
 */
export async function newSpaceFor(options: {
	name: string;
	folder: string;
}): Promise<{spaceId: string; tabId: string} | null> {
	try {
		const answer = await doCommand('space.new', {
			name: options.name,
			folder: options.folder,
			focus: false,
		});
		const spaceId = answerField(answer, 'space');
		const tabId = answerField(answer, 'tab');
		return spaceId && tabId ? {spaceId, tabId} : null;
	} catch (error) {
		log.error(
			'Could not make a space in the Herdr window',
			error instanceof Error ? error : undefined,
		);
		return null;
	}
}

/**
 * Show the tab that holds a terminal.
 *
 * This is the desktop equivalent of `switch-client`: the app keeps every space
 * and tab live, so showing one is selecting it, and the panes come with it.
 */
export async function showTerminalTab(
	terminalId: string,
	options: {attempts?: number; delayMs?: number} = {},
): Promise<boolean> {
	const attempts = options.attempts ?? 6;
	const delayMs = options.delayMs ?? 150;

	// The window adopts a new terminal asynchronously, so a terminal started a
	// moment ago may not be in the listing yet. Poll briefly rather than lose
	// the switch.
	for (let attempt = 0; attempt < attempts; attempt++) {
		let spaces: AppSpace[];
		try {
			spaces = await listSpaces();
		} catch {
			return false;
		}

		const found = findTerminalTab(spaces, terminalId);
		if (found) {
			try {
				await doCommand('space.select', {id: found.space.id});
				await doCommand('tab.select', {id: found.tab.id});
				return true;
			} catch (error) {
				log.warn(
					`Could not select the tab holding ${terminalId}`,
					error instanceof Error ? error : undefined,
				);
				return false;
			}
		}

		if (attempt < attempts - 1) await sleep(delayMs);
	}

	return false;
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>(resolve => {
		setTimeout(resolve, ms);
	});
}

/**
 * The pane ids of the tab holding a terminal, in the window's order.
 *
 * The rail's own pane comes first because it was there first; the agent and
 * companion follow in the order they were adopted.
 */
export function paneIdsOfTab(
	spaces: readonly AppSpace[],
	terminalId: string,
): string[] {
	const found = findTerminalTab(spaces, terminalId);
	return found ? found.tab.terminals.map(terminal => terminal.pane) : [];
}

/**
 * Whether a space already has a tab of its own, which is what tells the
 * desktop backend that a space is ready to show rather than needing to be
 * created.
 */
export function spaceHasPanes(space: AppSpace | undefined): boolean {
	return (space?.tabs.length ?? 0) > 0;
}
