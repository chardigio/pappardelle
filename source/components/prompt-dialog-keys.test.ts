import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import PromptDialog from './PromptDialog.tsx';

// The dialog reads its profiles from the repository it runs in.
const repository = mkdtempSync(path.join(tmpdir(), 'pappa-prompt-repo-'));
spawnSync('git', ['init', '-q', repository]);
writeFileSync(
	path.join(repository, '.pappardelle.yml'),
	'version: 1\nprofiles:\n  dev:\n    display_name: Dev\ndefault_profile: dev\n',
);
process.chdir(repository);
delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
test.after.always(() => {
	rmSync(repository, {recursive: true, force: true});
});

test('Enter Enter in one write picks the preselected profile once', async t => {
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
