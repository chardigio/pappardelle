// The rail's pane layout, arranged by herdr instead of tmux.
//
// Pappardelle shows three panes: the rail (this process), an agent viewer and
// a companion viewer. Under tmux those viewers are panes running a nested
// `tmux attach`; under herdr they are panes running a nested `hc attach`.
// The shape is the same, so the layout maths is the same too -- only the calls
// that build it differ.
//
// A pane is created by splitting, and each split returns the new pane's id.
// The three-pane shape is a right split (rail | rest), then the rest split
// again (agent | companion), which is what tmux's own layout produces.
//
// Calls go through the `herdr` CLI: the session server answers one request per
// connection, so it cannot back a long-lived client (see cli.ts).

import {herdrCli, isMissing} from './cli.ts';

/** What herdr calls a pane inside this project. */
export type HerdrPaneId = string;

export type HerdrLayout = {
	workspaceId: string;
	tabId: string;
	listPaneId: HerdrPaneId;
	agentPaneId: HerdrPaneId;
	/** Empty when the screen is too narrow for a companion. */
	companionPaneId: HerdrPaneId | '';
};

type RawPane = {
	pane_id: string;
	tab_id?: string;
	workspace_id?: string;
	focused?: boolean;
	cwd?: string | null;
	label?: string | null;
	terminal_title?: string | null;
};

type SplitDirection = 'right' | 'down';

/**
 * The workspace this process runs in, from the ids herdr injects into every
 * pane it manages. Null outside herdr, which is what makes the backend a
 * choice rather than a hard dependency.
 */
export function currentHerdrWorkspace(
	env: NodeJS.ProcessEnv = process.env,
): {workspaceId: string; tabId: string; paneId: string} | null {
	const workspaceId = env['HERDR_WORKSPACE_ID'];
	const tabId = env['HERDR_TAB_ID'];
	const paneId = env['HERDR_PANE_ID'];
	if (!workspaceId || !tabId || !paneId) return null;
	return {workspaceId, tabId, paneId};
}

export function isInHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
	return currentHerdrWorkspace(env) !== null;
}

/**
 * Split `paneId`, returning the new pane.
 *
 * herdr's `ratio` is the share the *target* pane keeps (0.7 leaves the target
 * 70% and the new pane 30%), so callers pass the share the pane should end
 * up with. `toHerdrRatio` converts a desired new-pane share.
 */
export async function splitPane(
	paneId: HerdrPaneId,
	direction: SplitDirection,
	options: {
		/** Share of the space the new pane takes, 0-1. */
		ratio?: number;
		cwd?: string;
		env?: Record<string, string>;
		focus?: boolean;
	} = {},
): Promise<HerdrPaneId> {
	const args = ['pane', 'split', paneId, '--direction', direction];
	if (options.ratio !== undefined) {
		args.push('--ratio', String(toHerdrRatio(options.ratio)));
	}

	if (options.cwd) args.push('--cwd', options.cwd);
	for (const [name, value] of Object.entries(options.env ?? {})) {
		args.push('--env', `${name}=${value}`);
	}

	args.push(options.focus ? '--focus' : '--no-focus');

	const raw = await herdrCli<{pane?: RawPane}>(args);
	const id = raw.pane?.pane_id;
	if (!id) throw new Error(`pane split returned no pane for ${paneId}`);
	return id;
}

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

/**
 * Turn the share the new pane should take into the ratio herdr wants, which is
 * the share the pane being split keeps.
 *
 * Rounded to four places: `1 - 0.7` is 0.30000000000000004, and a ratio is a
 * fraction of whole columns, so the extra digits are noise.
 */
export function toHerdrRatio(newPaneShare: number): number {
	const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, newPaneShare));
	const target = Math.min(MAX_RATIO, Math.max(MIN_RATIO, 1 - clamped));
	return Math.round(target * 10_000) / 10_000;
}

export type PaneListing = {
	paneId: HerdrPaneId;
	tabId: string;
	workspaceId: string;
	label: string | null;
	title: string | null;
	cwd: string | null;
	focused: boolean;
};

export async function listPanes(workspaceId: string): Promise<PaneListing[]> {
	const raw = await herdrCli<{panes?: RawPane[]}>([
		'pane',
		'list',
		'--workspace',
		workspaceId,
	]);
	return (raw.panes ?? []).map(pane => ({
		paneId: pane.pane_id,
		tabId: pane.tab_id ?? '',
		workspaceId: pane.workspace_id ?? workspaceId,
		label: pane.label ?? null,
		title: pane.terminal_title ?? null,
		cwd: pane.cwd ?? null,
		focused: pane.focused ?? false,
	}));
}

export async function getPane(
	paneId: HerdrPaneId,
): Promise<PaneListing | null> {
	try {
		const raw = await herdrCli<{
			pane?: RawPane;
			pane_id?: string;
		}>(['pane', 'get', paneId]);
		const {pane} = raw;
		if (pane) {
			return {
				paneId: pane.pane_id,
				tabId: pane.tab_id ?? '',
				workspaceId: pane.workspace_id ?? '',
				label: pane.label ?? null,
				title: pane.terminal_title ?? null,
				cwd: pane.cwd ?? null,
				focused: pane.focused ?? false,
			};
		}

		// Some responses are the pane itself rather than a wrapper.
		if (raw.pane_id) {
			const self = raw as unknown as RawPane;
			return {
				paneId: self.pane_id,
				tabId: self.tab_id ?? '',
				workspaceId: self.workspace_id ?? '',
				label: self.label ?? null,
				title: self.terminal_title ?? null,
				cwd: self.cwd ?? null,
				focused: self.focused ?? false,
			};
		}

		return null;
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

/** Name the rail's own pane, so a later run can find it again. */
export async function labelPane(
	paneId: HerdrPaneId,
	label: string,
): Promise<void> {
	await herdrCli(['pane', 'rename', paneId, label]).catch(() => undefined);
}

/** Focus a pane, as tmux's `select-pane` does. */
export async function focusPane(paneId: HerdrPaneId): Promise<void> {
	await herdrCli(['pane', 'focus', '--pane', paneId]).catch(() => undefined);
}

/** Close a pane. A pane that has already gone is not an error. */
export async function closePane(paneId: HerdrPaneId): Promise<boolean> {
	if (!paneId) return true;
	try {
		await herdrCli(['pane', 'close', paneId]);
		return true;
	} catch (error) {
		if (isMissing(error)) return true;
		throw error;
	}
}

/** Type a command line into a pane and press Enter, as `respawn-pane` did. */
export async function runInPane(
	paneId: HerdrPaneId,
	command: string,
): Promise<void> {
	// `pane run` acknowledges by exiting; it prints no JSON body.
	await herdrCli(['pane', 'run', paneId, command]);
}

/** Type text into a pane without pressing Enter. */
export async function sendTextToPane(
	paneId: HerdrPaneId,
	text: string,
): Promise<void> {
	await herdrCli(['pane', 'send-text', paneId, text]);
}

/** Press named keys in a pane. */
export async function sendKeysToPane(
	paneId: HerdrPaneId,
	keys: readonly string[],
): Promise<void> {
	await herdrCli(['pane', 'send-keys', paneId, ...keys]);
}

/**
 * The pane's text as Pappardelle's screen parsers want it: the last screenful
 * plus recent output, with soft wraps joined. `ansi` keeps escape sequences,
 * which the prompt and composer parsers read.
 */
export async function readPane(
	paneId: HerdrPaneId,
	options: {lines?: number; ansi?: boolean} = {},
): Promise<string> {
	const args = ['pane', 'read', paneId, '--source', 'recent-unwrapped'];
	if (options.lines !== undefined) args.push('--lines', String(options.lines));
	if (options.ansi) args.push('--format', 'ansi');

	const raw = await herdrCli<{
		read?: {text?: string};
		text?: string;
		content?: string;
	}>(args);
	return raw.read?.text ?? raw.text ?? raw.content ?? '';
}

/**
 * The dimensions of a tab, for the layout maths that decides how wide the rail
 * should be. This must be the whole area, not one pane's rectangle: the layout
 * is computed before any split, when the rail pane still covers the tab.
 */
export async function paneGeometry(
	paneId: HerdrPaneId,
): Promise<{cols: number; rows: number} | null> {
	try {
		const raw = await herdrCli<{
			layout?: {
				area?: {width?: number; height?: number};
				panes?: Array<{
					pane_id?: string;
					rect?: {width?: number; height?: number};
				}>;
			};
		}>(['pane', 'layout', '--pane', paneId]);

		// Before any split the area is the pane; after one the area stays the
		// tab's, which is what the ratios are relative to.
		const area = raw.layout?.area;
		if (area?.width && area.height) {
			return {cols: area.width, rows: area.height};
		}

		const pane = raw.layout?.panes?.find(entry => entry.pane_id === paneId);
		const rect = pane?.rect;
		if (!rect?.width || !rect.height) return null;
		return {cols: rect.width, rows: rect.height};
	} catch {
		return null;
	}
}

/** Create a workspace for a layout that has none yet, returning its root pane. */
export async function createWorkspace(options: {
	label: string;
	cwd: string;
	env?: Record<string, string>;
}): Promise<{workspaceId: string; tabId: string; paneId: HerdrPaneId}> {
	const args = [
		'workspace',
		'create',
		'--label',
		options.label,
		'--cwd',
		options.cwd,
	];
	for (const [name, value] of Object.entries(options.env ?? {})) {
		args.push('--env', `${name}=${value}`);
	}

	const raw = await herdrCli<{
		workspace?: {workspace_id?: string};
		tab?: {tab_id?: string};
		root_pane?: {pane_id?: string};
	}>(args);

	const workspaceId = raw.workspace?.workspace_id;
	const tabId = raw.tab?.tab_id;
	const paneId = raw.root_pane?.pane_id;
	if (!workspaceId || !tabId || !paneId) {
		throw new Error('workspace create returned an incomplete workspace');
	}

	return {workspaceId, tabId, paneId};
}
