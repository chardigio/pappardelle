// The environment variables that move Pappardelle's state, read in one place.

export type StateEnv = {
	/**
	 * PAPPARDELLE_SQLITE_STATE: experimental.sqliteState for this process and
	 * its children, whatever the config says. It lets a test run choose the mode.
	 */
	sqliteState: boolean | undefined;
	/** PAPPARDELLE_STATE_DB: the database to use in place of the default one. */
	dbPath: string | undefined;
	/**
	 * PAPPARDELLE_STATUS_DIR: where the Claude hook keeps its status files. The
	 * hook reads the same variable, so a test or a timer service moves the
	 * files for the writer and the readers at once.
	 */
	claudeStatusDir: string | undefined;
	/**
	 * PAPPARDELLE_STATUS_SOCKET: the status daemon's socket, in place of the
	 * one beside the database. The hook reads the same variable.
	 */
	statusSocket: string | undefined;
};

export function readStateEnv(env: NodeJS.ProcessEnv = process.env): StateEnv {
	const sqliteState = env['PAPPARDELLE_SQLITE_STATE'];
	return {
		sqliteState:
			sqliteState === '1' ? true : sqliteState === '0' ? false : undefined,
		dbPath: env['PAPPARDELLE_STATE_DB'],
		claudeStatusDir: env['PAPPARDELLE_STATUS_DIR'],
		statusSocket: env['PAPPARDELLE_STATUS_SOCKET'],
	};
}
