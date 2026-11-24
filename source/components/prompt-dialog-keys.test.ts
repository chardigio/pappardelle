import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {tempDir} from '../../test/helpers/temp-dir.ts';
import PromptDialog from './PromptDialog.tsx';

test('Enter Enter in one write picks the preselected profile once', async t => {
	// The dialog reads its profiles from the repository it runs in. A
	// Pappardelle space exports its main checkout, which the config reads ahead
	// of the working directory.
	const repository = tempDir(t, 'pappa-prompt-repo-');
	spawnSync('git', ['init', '-q', repository]);
	writeFileSync(
		path.join(repository, '.pappardelle.yml'),
		'version: 1\nprofiles:\n  dev:\n    display_name: Dev\ndefault_profile: dev\n',
	);
	const cwd = process.cwd();
	const mainRepoRoot = process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	process.chdir(repository);
	delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	t.teardown(() => {
		process.chdir(cwd);
		if (mainRepoRoot !== undefined)
			process.env['PAPPARDELLE_MAIN_REPO_ROOT'] = mainRepoRoot;
	});
	const submitted: Array<[string, string | null]> = [];
	const view = await render(
		React.createElement(PromptDialog, {
			onSubmit(prompt, profileName) {
				submitted.push([prompt, profileName]);
			},
			onCancel() {},
			availableWidth: 80,
			isInTmux: false,
		}),
	);
	t.teardown(async () => view.unmount());
	await view.stdin.write('fix the login\r\r');
	t.deepEqual(submitted, [['fix the login', 'dev']]);
});
