// Footer hint string for ErrorDisplay. Combines the two signals (hidden
// overflow + per-error truncation) so neither is silently dropped when both
// are true.

const LOGS_PATH = '~/.pappardelle/logs/';

export function buildLogsHint(
	hiddenCount: number,
	anyTruncated: boolean,
): string {
	if (hiddenCount > 0 && anyTruncated) {
		return `...and ${hiddenCount} more — errors truncated (see ${LOGS_PATH})`;
	}

	if (hiddenCount > 0) {
		return `...and ${hiddenCount} more (see ${LOGS_PATH})`;
	}

	return `Truncated — full text in ${LOGS_PATH}`;
}
