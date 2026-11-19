// Setting up the rail under the Herdr desktop app.
//
// This is the "lite" split of work: the window owns the panes, so Pappardelle
// creates no layout at all. The rail already *is* a pane, and each workspace
// gets a tab of its own whose panes the window makes by adopting the space's
// terminals (see app-layout.ts).
//
// So "setting up the layout" here means only finding the rail's own pane and
// the ids the rest of the TUI expects. There is no splitting, no ratio, and no
// width maths -- the window resizes panes itself, and the person can drag them.

import {createLogger} from '../logger.ts';
import {startupTrace} from '../startup-trace.ts';
import type {PaneLayout} from '../types.ts';
import {locateInApp} from './app-layout.ts';

const log = createLogger('herdr-app-layout');

/**
 * The rail's own pane, in the shape the TUI expects.
 *
 * `agentViewerPaneId` and `companionViewerPaneId` are empty on purpose: those
 * panes belong to a *space's* tab, not to the rail's, and the window shows
 * them when that tab is selected. Handing back the rail's own id would make
 * the TUI write into the list it is drawing.
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

		done?.();
		log.info(
			`Herdr window: rail pane ${location.paneId} in space ${location.spaceId}, tab ${location.tabId}`,
		);

		return {
			listPaneId: location.paneId,
			agentViewerPaneId: '',
			companionViewerPaneId: '',
		};
	} catch (error) {
		log.error(
			'Failed to find the rail pane in the Herdr window',
			error instanceof Error ? error : undefined,
		);
		done?.('failed');
		return null;
	}
}
