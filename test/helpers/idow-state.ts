// The stores an idow fixture's runs record to, for the idow-*.test.ts files
// to seed and read between runs.
import path from 'node:path';
import {
	createStateDaos,
	openImportedStateDb,
	type StateDaos,
} from '../../source/state-daos.ts';
import {
	closeStateDb,
	stateDbPath,
	type StateDb,
} from '../../source/state-db.ts';
import {statusSocket} from '../../source/program-status-monitor.ts';
import {recordAgentSessions} from './state.ts';
import {teardown} from './teardown.ts';

/** The repo idow names the fixture's main checkout as. */
export const IDOW_REPO = 'main checkout';

export type IdowState = {
	daos: StateDaos;
	stateDir: string;
	dbPath: string;
	/** The database the fixture's runs and `daos` share. */
	db: () => StateDb['db'];
	/** Replace a space's agent sessions, as the agent's hook leaves them. */
	recordSessions(key: string, sessions: Record<string, string>): void;
};

export function idowState(fixture: {home: string; main: string}): IdowState {
	const stateDir = path.join(fixture.home, '.pappardelle');
	const dbPath = stateDbPath(stateDir);
	const daos = createStateDaos({
		repo: IDOW_REPO,
		stateDir,
		home: fixture.home,
		mainRoot: () => fixture.main,
	});
	teardown(() => {
		daos.disconnectStatusDaemon();
		closeStateDb(dbPath);
	});
	const db = () =>
		openImportedStateDb(dbPath, stateDir, {
			home: fixture.home,
			socket: statusSocket(),
			mainRoot: () => fixture.main,
		}).db;
	return {
		daos,
		stateDir,
		dbPath,
		db,
		recordSessions(key, sessions) {
			db();
			recordAgentSessions(dbPath, IDOW_REPO, key, sessions);
		},
	};
}
