import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripHostPappardelleEnv} from '../test/helpers/env.ts';

/**
 * Run a check in a process of its own under a throwaway HOME. The App merges
 * ~/.pappardelle/.pappardelle.yml, so a developer's global config can open
 * dialogs over the rail, and a check's panes and logs write under HOME. Bun
 * fixes homedir() at startup.
 */
export function runUnderThrowawayHome(check: URL): void {
	const home = mkdtempSync(path.join(tmpdir(), 'pappa-app-home-'));
	const env: NodeJS.ProcessEnv = {...stripHostPappardelleEnv(), HOME: home};
	try {
		const {status} = spawnSync(
			process.execPath,
			[fileURLToPath(check), ...process.argv.slice(2)],
			{stdio: 'inherit', env},
		);
		process.exitCode = status ?? 1;
	} finally {
		rmSync(home, {recursive: true, force: true});
	}
}
