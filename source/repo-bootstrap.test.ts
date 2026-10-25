import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'ava';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.join(
	here,
	'..',
	'node_modules',
	'tsx',
	'dist',
	'esm',
	'index.mjs',
);

// The popup child is a fresh node process. This runs one the same way, in a
// repo configured for beads, and asks which tracker it ended up with.
function trackerInFreshProcess(bootstrap: boolean): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-repo-'));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-home-'));
	try {
		execFileSync('git', ['init', '-q'], {cwd: root});
		fs.writeFileSync(
			path.join(root, '.pappardelle.yml'),
			'version: 1\nissue_tracker:\n  provider: beads\n',
		);
		const script = [
			bootstrap
				? `const {bootstrapRepo} = await import(${JSON.stringify(path.join(here, 'repo-bootstrap.ts'))}); bootstrapRepo();`
				: '',
			`const {createIssueTracker} = await import(${JSON.stringify(path.join(here, 'providers', 'index.ts'))});`,
			'console.log(createIssueTracker().name);',
		].join('\n');
		return execFileSync(
			process.execPath,
			[
				'--import',
				pathToFileURL(tsx).href,
				'--input-type=module',
				'-e',
				script,
			],
			{
				cwd: root,
				encoding: 'utf8',
				env: {...process.env, HOME: home},
			},
		).trim();
	} finally {
		fs.rmSync(root, {recursive: true, force: true});
		fs.rmSync(home, {recursive: true, force: true});
	}
}

test('a fresh process picks up the repo configured tracker after bootstrap', t => {
	t.is(trackerInFreshProcess(false), 'linear');
	t.is(trackerInFreshProcess(true), 'beads');
});
