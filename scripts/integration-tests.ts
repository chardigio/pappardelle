// Runs the account-free integration checks, each in a process of its own
// under the test tmux guard and a throwaway HOME. The App merges
// ~/.pappardelle/.pappardelle.yml, so a developer's global config can open
// dialogs over the rail, and a check's panes and logs write under HOME.
//
// Usage: bun scripts/integration-tests.ts [name...] [--flag...]. No names runs
// every check; flags such as --keep pass to each one.
import fs from 'node:fs';
import path from 'node:path';
import {makeThrowawayHome, testRunEnv} from '../test/helpers/env.ts';

const CHECKS = [
	'program-status',
	'program-status-lifecycle',
	'program-status-cleanup',
	'program-status-app',
	'program-resume',
	'unreadable-state-app',
	'popup-close',
	'rail-boxes',
];

const repoRoot = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith('--'));
const names = args.filter(arg => !arg.startsWith('--'));
const unknown = names.filter(name => !CHECKS.includes(name));
if (unknown.length > 0) {
	throw new Error(
		`Unknown integration check ${unknown.join(', ')}. The checks are: ${CHECKS.join(', ')}`,
	);
}

const failed: string[] = [];
for (const name of names.length > 0 ? names : CHECKS) {
	const home = makeThrowawayHome();
	try {
		const check = Bun.spawnSync(
			[
				path.join(repoRoot, 'test/helpers/tmux-guard-run.sh'),
				process.execPath,
				path.join(repoRoot, 'integration-tests', `${name}-check.ts`),
				...flags,
			],
			{
				cwd: repoRoot,
				env: testRunEnv(home),
				stdio: ['inherit', 'inherit', 'inherit'],
			},
		);
		if (!check.success) failed.push(name);
	} finally {
		fs.rmSync(home, {recursive: true, force: true});
	}
}

if (failed.length > 0) {
	console.error(`Failed integration checks: ${failed.join(', ')}`);
	process.exitCode = 1;
}
