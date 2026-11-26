// The environment variables that move Pappardelle's state, read in one place.

export type StateEnv = {
	/** PAPPARDELLE_STATE_DB: the database to use in place of the default one. */
	dbPath: string | undefined;
	/**
	 * PAPPARDELLE_STATUS_SOCKET: the status daemon's socket, in place of the
	 * one beside the database. The hook reads the same variable.
	 */
	statusSocket: string | undefined;
};

// An empty value means unset, as it does to install.sh and the hooks.
export function readStateEnv(env: NodeJS.ProcessEnv = process.env): StateEnv {
	return {
		dbPath: env['PAPPARDELLE_STATE_DB'] || undefined,
		statusSocket: env['PAPPARDELLE_STATUS_SOCKET'] || undefined,
	};
}
