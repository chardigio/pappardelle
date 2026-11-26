import {newSpaceIdentity} from '../../source/space-identity.ts';
import {SqliteSpaceRegistryDao} from '../../source/space-registry-sqlite.ts';
import {openStateDb} from '../../source/state-db.ts';

/** Identities for registries built by hand: every key named as idow names it. */
export function everyKeyNamed(repo: string) {
	return {
		get: (key: string) =>
			({
				kind: 'identity',
				identity: newSpaceIdentity({
					repo,
					key,
					worktreePath: `/w/${key}`,
					socket: 'pappardelle_inner',
				}),
			}) as const,
	};
}

/**
 * A registry on the database at `dbPath` that believes it is process `pid`
 * and asks `isPidAlive` whether another owner still runs.
 */
export function registryAs(
	dbPath: string,
	repo: string,
	pid: number,
	isPidAlive: (pid: number) => boolean,
): SqliteSpaceRegistryDao {
	return new SqliteSpaceRegistryDao(
		() => openStateDb(dbPath),
		repo,
		everyKeyNamed(repo),
		pid,
		isPidAlive,
	);
}
