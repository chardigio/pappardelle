export const PANE_GEOMETRY_FORMAT =
	'#{pane_id} #{pane_width} #{pane_height} #{window_width} #{window_height} #{window_zoomed_flag} #{pane_right}';

/** `right` is the pane's last column, counted from the window's left edge. */
export type PaneGeometry = {cols: number; rows: number; right: number};
export type WindowGeometry = {
	window: {width: number; height: number; zoomed: boolean};
	panes: Map<string, PaneGeometry>;
};

export function paneGeometryArgs(paneId: string): string[] {
	return ['list-panes', '-t', paneId, '-F', PANE_GEOMETRY_FORMAT];
}

export function parseWindowGeometry(output: string): WindowGeometry {
	const panes = new Map<string, PaneGeometry>();
	let window: WindowGeometry['window'] | undefined;
	for (const line of output.trim().split('\n')) {
		const [id, ...fields] = line.split(' ');
		const [cols, rows, width, height, zoomed, right] = fields.map(Number);
		if (
			!id ||
			!cols ||
			!rows ||
			!width ||
			!height ||
			right === undefined ||
			Number.isNaN(right)
		)
			throw new Error('Invalid tmux window geometry');
		window = {width, height, zoomed: zoomed === 1};
		panes.set(id, {cols, rows, right});
	}
	if (!window) throw new Error('Missing tmux window geometry');
	return {window, panes};
}

export function paneGeometry(
	snapshot: WindowGeometry,
	paneId: string,
): PaneGeometry {
	const dimensions = snapshot.panes.get(paneId);
	if (!dimensions) throw new Error('Pane missing from tmux window geometry');
	return dimensions;
}
