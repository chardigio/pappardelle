/**
 * Outer width for the new-session dialog's frames.
 *
 * A plain `<Box borderStyle>` needs no width — Ink stretches it to the parent,
 * which is how the dialog filled the pane before it grew a hand-drawn top rule.
 * `TitledBox` has to lay that rule out itself, so it needs a concrete number,
 * and this is where "the number that reproduces stretching" lives.
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
