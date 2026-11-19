// Setting up the rail's pane layout in the Herdr desktop app.
//
// This is `setupPappardellLayout` in tmux.ts, expressed with the app's pane
// calls. The shape it builds is the same -- rail, agent viewer, companion
// viewer -- because the person should see what tmux shows them, not a rail in
// a tab of its own.
//
// The window has no ratio argument on `pane.split`, so the splits come out
// equal. Splitting the rail's pane right twice gives rail | agent | companion,
// and the person can drag the boundaries afterwards (the app's dividers are
// resizable). Nothing here reattaches: the viewers are panes, and showing a
// space in them is `terminal.show` (see attachDesktopSpace in tmux.ts).
//
// The panes outlive this process, so a relaunch finds them here and reuses
// them instead of splitting again.

import {createLogger} from '../logger.ts';
import {startupTrace} from '../startup-trace.ts';
import type {PaneLayout} from '../types.ts';
import {
	closePaneInApp,
	focusPaneInApp,
	findViewerPanes,
	locateInApp,
	nameTab,
	splitPaneInApp,
} from './app-layout.ts';
import {labelTerminal, VIEWER_LABEL, VIEWER_ROLE_LABEL} from './terminals.ts';

const log = createLogger('herdr-app-layout');

/** Split a pane and label the terminal as one of the rail's viewers. */
async function makeViewer(
	railPaneId: string,
	railTerminal: string,
	role: 'agent' | 'companion',
): Promise<{paneId: string; terminalId: string} | null> {
	const viewer = await splitPaneInApp(railPaneId, 'right');
	if (!viewer) return null;
	const labelled = await labelTerminal(viewer.terminalId, {
		[VIEWER_LABEL]: railTerminal,
		[VIEWER_ROLE_LABEL]: role,
	}).catch(() => false);
	if (!labelled) {
		// Unlabelled, a relaunch cannot tell this pane from one the person
		// made, so it is closed rather than left to be adopted by guesswork.
		log.warn(`Could not label the ${role} viewer; closing it`);
		await closePaneInApp(viewer.paneId).catch(() => undefined);
		return null;
	}

	return viewer;
}

/**
 * The rail's own pane plus the two viewer panes, in the shape the TUI expects.
 *
 * Returns null when this process is not inside the window, which is how the
 * caller knows to keep another backend.
 */
export async function setupDesktopLayout(): Promise<PaneLayout | null> {
	const done = startupTrace.current?.begin('layout-setup');

	try {
		const location = await locateInApp();
		if (!location) {
			log.error('This process is not a pane in the Herdr window');
			done?.('failed');
			return null;
		}

		// The rail's terminal is what the viewers are labelled with, so a
		// relaunch can tell its own panes from any the person split.
		const railTerminal = process.env['HC_TERMINAL_ID'] ?? '';
		if (!railTerminal) {
			log.error('This process has no HC_TERMINAL_ID to key the layout on');
			done?.('failed');
			return null;
		}

		const existing = await findViewerPanes(railTerminal).catch(() => ({
			agent: '',
			companion: '',
		}));

		// A relaunch finds the panes an earlier run labelled. An empty agent
		// entry means there are none yet, not that the tab is bare: a person's
		// own panes sit here too, and those are left alone.
		let agentViewerPaneId = existing.agent;
		let companionViewerPaneId = existing.companion;
		if (!agentViewerPaneId) {
			const agent = await makeViewer(location.paneId, railTerminal, 'agent');
			if (!agent) {
				done?.('failed');
				return null;
			}

			agentViewerPaneId = agent.paneId;
			const companion = await makeViewer(
				agent.paneId,
				railTerminal,
				'companion',
			);
			companionViewerPaneId = companion?.paneId ?? '';
		}

		// The rail keeps the keyboard, as the tmux layout leaves it.
		await focusPaneInApp(location.paneId).catch(() => undefined);
		await nameTab(location.tabId, 'pappardelle').catch(() => undefined);

		done?.();
		log.info(
			`Herdr window: rail ${location.paneId}, agent ${agentViewerPaneId}, companion ${companionViewerPaneId || '(none)'}, in space ${location.spaceId}, tab ${location.tabId}`,
		);

		return {
			listPaneId: location.paneId,
			agentViewerPaneId,
			companionViewerPaneId,
		};
	} catch (error) {
		log.error(
			'Failed to set up the Herdr window layout',
			error instanceof Error ? error : undefined,
		);
		done?.('failed');
		return null;
	}
}
