import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The App merges ~/.pappardelle/.pappardelle.yml, so a developer's global
// config can open dialogs over the rail. Bun fixes homedir() at startup, so the
// check runs in its own process under a throwaway HOME.
const home = mkdtempSync(path.join(tmpdir(), 'pappa-app-home-'));
try {
	const {status} = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('program-status-app-check.ts', import.meta.url)),
			...process.argv.slice(2),
		],
		{stdio: 'inherit', env: {...process.env, HOME: home}},
	);
	process.exitCode = status ?? 1;
} finally {
	rmSync(home, {recursive: true, force: true});
}
