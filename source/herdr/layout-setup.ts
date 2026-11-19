// Setting up the rail's pane layout under herdr.
//
// This is `setupPappardellLayout` in tmux.ts, expressed with herdr's pane
// calls. The shape it builds is identical -- rail, agent viewer, companion
// viewer, with the same width maths and the same narrow-screen fallback -- so
// the rest of the TUI sees the same three pane ids it always has.
//
// The viewers are panes that run `hc attach <terminal>`; under tmux they ran
// `tmux attach -t <session>`. Everything downstream (which pane shows which
// space) is a matter of retyping that command, exactly as `switch-client` used
// to retarget a nested tmux client.

import {createLogger} from '../logger.ts';
import {startupTrace} from '../startup-trace.ts';
import type {PaneLayout} from '../types.ts';
import {herdrAttachCommand} from '../backend.ts';
import {calculateLayoutForSize, MIN_COMPANION_WIDTH} from '../layout-sizing.ts';
import {getRegisteredSpaces} from '../space-registry.ts';
import {terminalName} from './terminals.ts';
import {
	closePane,
	currentHerdrWorkspace,
	focusPane,
	labelPane,
	paneGeometry,
	runInPane,
	sendKeysToPane,
	splitPane,
} from './layout.ts';

/** hc's detach key for an attached viewer. */
export const DETACH_KEY = 'ctrl+backslash';

const log = createLogger('herdr-layout');

/** Label the rail's own pane, so a later run can find it again. */
const RAIL_LABEL = 'rail';
const AGENT_LABEL = 'agent';
const COMPANION_LABEL = 'companion';

/**
 * The command a viewer pane runs to show a space's terminal. It ends in a
 * login shell, the same way the tmux viewer does, so a detach leaves a usable
 * pane rather than a dead one.
 *
 * `hc attach` takes a terminal name or address, and hc's names are its own
 * (`agent-repo-sta-1-abc123`), so the space's session name is mapped the way
 * every other terminal lookup maps it.
 */
export function herdrViewerCommand(sessionName: string): string {
	return `${herdrAttachCommand(terminalName(sessionName))} || exec "$SHELL" -l`;
}

/** The pane ids this function created, so a failed setup can undo them. */
type Created = {agent?: string; companion?: string};

/**
 * Split the rail's pane into the layout the screen has room for.
 *
 * Returns null when this process is not running under herdr, which is how the
 * caller knows to keep the tmux path.
 */
export async function setupHerdrLayout(): Promise<PaneLayout | null> {
	const workspace = currentHerdrWorkspace();
	if (!workspace) {
		log.error('HERDR_PANE_ID environment variable not set');
		return null;
	}

	const done = startupTrace.current?.begin('layout-setup');
	const {paneId: listPaneId} = workspace;
	const created: Created = {};

	try {
		const geometry = await paneGeometry(listPaneId);
		const totalWidth = geometry?.cols ?? process.stdout.columns ?? 120;
		const totalHeight = geometry?.rows ?? process.stdout.rows ?? 40;
		// Same maths as the tmux path: the space count decides the rail's
		// height, and the pinned main-worktree row is always drawn.
		const layout = calculateLayoutForSize(
			totalWidth,
			totalHeight,
			getRegisteredSpaces().length,
		);

		log.info(
			`Terminal size: ${totalWidth}x${totalHeight}, layout: ${layout.direction}`,
		);

		if (layout.direction === 'vertical') {
			// Rail on top, agent below, no companion.
			created.agent = await splitPane(listPaneId, 'down', {
				ratio: share(layout.agentHeight ?? totalHeight / 2, totalHeight),
				cwd: process.cwd(),
			});
		} else {
			const hasCompanion = (layout.companionWidth ?? 0) >= MIN_COMPANION_WIDTH;
			const agentWidth = layout.agentWidth ?? 40;
			const companionWidth = layout.companionWidth ?? 0;

			if (hasCompanion) {
				// First carve the agent + companion band off the rail, then split
				// that band so the companion takes the rightmost share.
				const bandWidth = agentWidth + companionWidth;
				const band = await splitPane(listPaneId, 'right', {
					ratio: share(bandWidth, totalWidth),
					cwd: process.cwd(),
				});
				created.agent = band;
				created.companion = await splitPane(band, 'right', {
					ratio: share(companionWidth, bandWidth),
					cwd: process.cwd(),
				});
			} else {
				log.info(
					`Not enough space for companion pane (need ${MIN_COMPANION_WIDTH}, have ${companionWidth})`,
				);
				created.agent = await splitPane(listPaneId, 'right', {
					ratio: share(agentWidth + companionWidth, totalWidth),
					cwd: process.cwd(),
				});
			}
		}

		await focusPane(listPaneId).catch(() => undefined);
		await labelPanes(listPaneId, created);

		done?.();
		log.info(
			`Set up pappardelle layout: list=${listPaneId}, agent=${created.agent}, companion=${created.companion ?? '(none)'}`,
		);

		return {
			listPaneId,
			agentViewerPaneId: created.agent!,
			companionViewerPaneId: created.companion ?? '',
		};
	} catch (error) {
		log.error(
			'Failed to set up pappardelle layout',
			error instanceof Error ? error : undefined,
		);
		done?.('failed');
		// Leave the window as it was rather than half split.
		for (const paneId of [created.companion, created.agent]) {
			if (paneId) await closePane(paneId).catch(() => undefined);
		}

		return null;
	}
}

/**
 * A new pane's share of the space it is split from. herdr wants the fraction
 * the *target* keeps, which `splitPane` converts, so this stays in the terms
 * the layout maths speaks: cells out of the whole.
 */
function share(part: number, whole: number): number {
	if (whole <= 0) return 0.5;
	return part / whole;
}

/** Name the three panes so a reader can tell them apart in `herdr pane list`. */
async function labelPanes(listPaneId: string, created: Created): Promise<void> {
	await labelPane(listPaneId, RAIL_LABEL).catch(() => undefined);
	if (created.agent) {
		await labelPane(created.agent, AGENT_LABEL).catch(() => undefined);
	}

	if (created.companion) {
		await labelPane(created.companion, COMPANION_LABEL).catch(() => undefined);
	}
}

/**
 * Show a space's agent and companion in the two viewer panes.
 *
 * Under tmux this was `switch-client` on the nested clients, which retargeted
 * an attached tmux client in place. An `hc attach` viewer has no equivalent
 * call, so it is detached (ctrl+backslash, hc's detach key) and the pane is
 * given the next `hc attach`. Typing the detach key into a pane that is already
 * at a shell prompt does nothing harmful, so the same sequence works before the
 * first attach and after any number of switches.
 */
export async function attachHerdrViewers(options: {
	layout: PaneLayout;
	agentTerminal: string;
	companionTerminal: string;
}): Promise<void> {
	const {layout, agentTerminal, companionTerminal} = options;

	await retargetViewer(layout.agentViewerPaneId, agentTerminal);
	if (layout.companionViewerPaneId && companionTerminal) {
		await retargetViewer(layout.companionViewerPaneId, companionTerminal);
	}
}

/** Detach whatever a viewer is showing, then attach it to `terminal`. */
async function retargetViewer(paneId: string, terminal: string): Promise<void> {
	await sendKeysToPane(paneId, [DETACH_KEY]).catch(() => undefined);
	await runInPane(paneId, herdrViewerCommand(terminal));
}
