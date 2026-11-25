import {spawnSync} from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {skillRoots, skillSnapshot} from '../skill-completion.ts';
import PromptDialog from './PromptDialog.tsx';

// The dialog reads its profiles and skills from the repository it runs in,
// and user skills from HOME. The repository root is cached for the process,
// so every test in this file shares one. A Pappardelle space exports its main
// checkout, which the config reads ahead of the working directory.
const sandbox = realpathSync(
	mkdtempSync(path.join(os.tmpdir(), 'pappa-prompt-')),
);
const repository = path.join(sandbox, 'repo');
const cwd = process.cwd();
const {HOME: home, PAPPARDELLE_MAIN_REPO_ROOT: mainRepoRoot} = process.env;

beforeAll(async () => {
	spawnSync('git', ['init', '-q', repository]);
	writeFileSync(
		path.join(repository, '.pappardelle.yml'),
		'version: 1\nprofiles:\n  dev:\n    display_name: Dev\n  frontend:\n    display_name: Frontend\ndefault_profile: dev\n',
	);
	for (const name of ['do-other', 'do-thing']) {
		const dir = path.join(repository, '.claude', 'skills', name);
		mkdirSync(dir, {recursive: true});
		writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
	}

	mkdirSync(path.join(sandbox, 'home'));
	process.chdir(repository);
	process.env['HOME'] = path.join(sandbox, 'home');
	delete process.env['PAPPARDELLE_MAIN_REPO_ROOT'];
	// Loaded ahead so the dialog's first frame already offers the skills.
	await skillSnapshot.refresh(skillRoots()!);
});

afterAll(() => {
	process.chdir(cwd);
	process.env['HOME'] = home;
	if (mainRepoRoot !== undefined)
		process.env['PAPPARDELLE_MAIN_REPO_ROOT'] = mainRepoRoot;
	rmSync(sandbox, {recursive: true, force: true});
});

async function renderDialog() {
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
	teardown(async () => view.unmount());
	return {view, submitted};
}

test('Enter Enter in one write picks the preselected profile once', async () => {
	const {view, submitted} = await renderDialog();
	await view.stdin.write('fix the login\r\r');
	expect(submitted).toStrictEqual([['fix the login', 'dev']]);
});

test('Enter after a skill name in the same write goes to the skill list', async () => {
	const {view, submitted} = await renderDialog();
	await view.stdin.write('/do\rj\r');
	expect(submitted).toStrictEqual([]);
	expect(view.lastFrame()).toContain('> /do-thing');
});
