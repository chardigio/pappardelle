// What a closed space leaves in the stores. Every close path, the reaper's
// included, ends here.

import {removeResumeFiles} from './resume-launch.ts';
import type {StateDaos} from './state-daos.ts';

/**
 * Forget a closed space's program status and its resume records: a space
 * closed on purpose comes back with nothing to restore.
 */
export async function forgetClosedSpace(
	daos: Pick<StateDaos, 'programStatus' | 'resumeRecords' | 'stateDir'>,
	repo: string,
	key: string,
): Promise<void> {
	removeResumeFiles(daos.stateDir, repo, key);
	await Promise.all([
		daos.programStatus.remove(key),
		daos.resumeRecords.remove(key),
	]);
}
