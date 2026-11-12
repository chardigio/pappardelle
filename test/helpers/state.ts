import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getRegistryPathForRepo} from '../../source/space-registry.ts';
import {createStateDaos, type StateDaos} from '../../source/state-daos.ts';
import {closeStateDb, stateDbPath} from '../../source/state-db.ts';
import {initTmuxState} from '../../source/tmux.ts';

/** Whether this test run keeps state in SQLite (PAPPARDELLE_SQLITE_STATE=1). */
export const sqliteRun = process.env['PAPPARDELLE_SQLITE_STATE'] === '1';

/** The part of an ava test context these helpers use. */
type Teardown = {teardown(fn: () => void): unknown};

export type TestState = {
	daos: StateDaos;
	stateDir: string;
	registryFile: string;
	/** Whether these stores keep rows. */
	sqlite: boolean;
};

/**
 * Stores on a temp directory of the test's own, in the run's mode unless
 * `sqlite` says otherwise. `spaces` is written as a registry file, the way a
 * process without the database would have left it.
 */
export function testState(
	t: Teardown,
	options: {
		repo?: string;
		spaces?: string[];
		sqlite?: boolean;
		clock?: () => Date;
	} = {},
): TestState {
	const repo = options.repo ?? 'repo';
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-test-state-')),
	);
	const registryFile = getRegistryPathForRepo(repo, stateDir);
	fs.mkdirSync(path.dirname(registryFile), {recursive: true});
	if (options.spaces)
		fs.writeFileSync(registryFile, JSON.stringify(options.spaces));

	const sqlite = options.sqlite ?? sqliteRun;
	const daos = createStateDaos({
		repo,
		stateDir,
		sqlite,
		clock: options.clock,
	});
	t.teardown(() => {
		closeStateDb(stateDbPath(stateDir));
		fs.rmSync(stateDir, {recursive: true, force: true});
	});
	return {daos, stateDir, registryFile, sqlite};
}

/** `testState`, also handed to tmux.ts for the functions that read stores. */
export function testTmuxState(
	t: Teardown,
	options: Parameters<typeof testState>[1] = {},
): TestState {
	const state = testState(t, options);
	initTmuxState(state.daos);
	return state;
}
