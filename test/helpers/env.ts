/**
 * Whether a test run drops an inherited variable. A run started inside a
 * space, or by a timer service, inherits that space's PAPPARDELLE_*, and the
 * state ones (PAPPARDELLE_STATE_DB, PAPPARDELLE_STATUS_SOCKET, ...) point past
 * any HOME at the real database. A test run keeps only its state mode and its
 * own PAPPARDELLE_TEST_* switches.
 */
export function isHostPappardelleEnv(name: string): boolean {
	return (
		name.startsWith('PAPPARDELLE_') &&
		name !== 'PAPPARDELLE_SQLITE_STATE' &&
		!name.startsWith('PAPPARDELLE_TEST_')
	);
}

/** Copy `source` without the variables {@link isHostPappardelleEnv} drops. */
export function stripHostPappardelleEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(source).filter(([key]) => !isHostPappardelleEnv(key)),
	);
}
