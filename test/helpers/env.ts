/**
 * Copy `source` without inherited host `PAPPARDELLE_*` overrides, keeping
 * `PAPPARDELLE_SQLITE_STATE` so tests still run in the matrix's state mode.
 */
export function stripHostPappardelleEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(source).filter(
			([key]) =>
				!key.startsWith('PAPPARDELLE_') || key === 'PAPPARDELLE_SQLITE_STATE',
		),
	);
}
