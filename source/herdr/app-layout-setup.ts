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
	focusPaneInApp,
	locateInApp,
	nameTab,
	splitPaneInApp,
	viewerPanesOf,
} from './app-layout.ts';
import {listSpaces} from './app.ts';

const log = createLogger('herdr-app-layout');

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

		const spaces = await listSpaces();
		const existing = viewerPanesOf(spaces, process.env['HC_TERMINAL_ID'] ?? '');

		// A relaunch finds the panes an earlier run made. Two is the shape this
		// builds; one means the companion was closed by hand, which the TUI
		// already handles.
		let viewerPanes = existing;
		if (viewerPanes.length === 0) {
			const agent = await splitPaneInApp(location.paneId, 'right');
			if (!agent) {
				done?.('failed');
				return null;
			}

			const companion = await splitPaneInApp(agent, 'right');
			viewerPanes = companion ? [agent, companion] : [agent];
		}

		const [agentViewerPaneId = '', companionViewerPaneId = ''] = viewerPanes;

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
