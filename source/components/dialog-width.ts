/**
 * Outer width for the new-session dialog's frames.
 *
 * `TitledBox` takes a concrete width. The dialog spans the pane edge to edge, so
 * this is the measured pane width, falling back to stdout columns.
 *
 * Deliberately uncapped and unfloored: master spans the pane edge to edge at any
 * size, and any clamp here shows up as either a narrow box floating in a wide
 * terminal or a border running past the edge of a narrow one.
 */
export function dialogWidth(
	availableWidth: number | undefined,
	stdoutColumns: number | undefined,
): number {
	for (const candidate of [availableWidth, stdoutColumns]) {
		if (candidate !== undefined && candidate > 0) return candidate;
	}

	return 80;
}
