import wrapAnsi from 'wrap-ansi';

/**
 * Split command output into rows that fit `width` columns. `bd show` pads and
 * wraps to 80 columns when piped regardless of the terminal, so its lines are
 * re-wrapped here instead of being truncated in narrower popups.
 */
export function toViewerLines(output: string, width: number): string[] {
	const text = output.replace(/\s+$/, '');
	if (!text) return [];
	return text.split('\n').flatMap(line =>
		wrapAnsi(line.trimEnd(), Math.max(1, width), {
			hard: true,
			trim: false,
		})
			.split('\n')
			.map(row => row.trimEnd()),
	);
}
