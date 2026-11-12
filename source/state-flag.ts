// experimental.sqliteState as processes other than the configured CLI see it.
//
// The Python hooks and the status monitors cannot afford to parse the YAML
// config on every event, so the CLI writes what the home config says to a
// small file whenever it starts, and they read that.

import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_STATE_DIR, stateDbPath} from './state-db.ts';

type ResolvedFlag = {sqliteState: boolean; db: string};

/** PAPPARDELLE_SQLITE_STATE, which lets a test run choose the mode. */
export function sqliteStateOverride(
	env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
	const value = env['PAPPARDELLE_SQLITE_STATE'];
	if (value === '1') return true;
	if (value === '0') return false;
	return undefined;
}

function resolvedFlagPath(stateDir: string): string {
	return path.join(stateDir, 'state-flag.json');
}

function readResolvedFlag(stateDir: string): ResolvedFlag | null {
	try {
		const parsed: unknown = JSON.parse(
			fs.readFileSync(resolvedFlagPath(stateDir), 'utf8'),
		);
		const flag = parsed as Partial<ResolvedFlag> | null;
		return typeof flag?.sqliteState === 'boolean' && typeof flag.db === 'string'
			? {sqliteState: flag.sqliteState, db: flag.db}
			: null;
	} catch {
		return null;
	}
}

/**
 * The flag for a process that outlives a config change and does not load the
 * config: the override, then what the CLI last recorded.
 */
export function readResolvedSqliteState(
	stateDir = DEFAULT_STATE_DIR,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		sqliteStateOverride(env) ?? readResolvedFlag(stateDir)?.sqliteState ?? false
	);
}

/**
 * Record the home config's value for the hooks. The override is never
 * written: a test run must not turn the database on for the hooks of the
 * user's real sessions. Nothing is written while the flag has never been on.
 */
export function recordSqliteState(
	configured: boolean,
	stateDir = DEFAULT_STATE_DIR,
): void {
	const recorded = readResolvedFlag(stateDir);
	if (recorded ? recorded.sqliteState === configured : !configured) return;
	fs.mkdirSync(stateDir, {recursive: true});
	const file = resolvedFlagPath(stateDir);
	const temporary = `${file}.tmp.${process.pid}`;
	fs.writeFileSync(
		temporary,
		JSON.stringify({
			sqliteState: configured,
			db: stateDbPath(stateDir),
		} satisfies ResolvedFlag) + '\n',
	);
	fs.renameSync(temporary, file);
}
