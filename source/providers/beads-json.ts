export function unwrapBeadsJson(
	stdout: string,
): Array<Record<string, unknown>> {
	const parsed = JSON.parse(stdout) as unknown;
	const payload =
		parsed !== null &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		'data' in parsed
			? (parsed as {data: unknown}).data
			: parsed;

	if (Array.isArray(payload)) {
		return payload.filter(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === 'object',
		);
	}

	if (payload !== null && typeof payload === 'object') {
		return [payload as Record<string, unknown>];
	}

	return [];
}
