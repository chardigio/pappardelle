/**
 * Regression tests for STA-1866 — workspace provisioning no longer opens a
 * placeholder PR/MR.
 *
 * The old flow (`create-github-pr.sh`, and the GitLab arm of `create_pr()`)
 * pushed an empty commit at provisioning time purely so a zero-diff PR could
 * exist for the rail to link to. That commit was then `git reset HEAD~1`'d
 * locally, leaving every new branch diverged from its own remote — the source
 * of the recurring force-with-lease dance in the `do-*` skills. The agent now
 * opens the PR at its first real commit instead.
 *
 * These assertions are deliberately source-level: the behaviour being pinned
 * is "provisioning never writes to origin", and the only honest way to test
 * that without a live remote is to prove the write primitives are absent from
 * the provisioning path.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';

const scriptsDir = path.resolve(import.meta.dirname, '../scripts');

function readScript(name: string): string {
	return fs.readFileSync(path.join(scriptsDir, name), 'utf-8');
}

test('create-github-pr.sh is gone', t => {
	t.false(
		fs.existsSync(path.join(scriptsDir, 'create-github-pr.sh')),
		'the placeholder-PR script must not be reintroduced',
	);
});

test('no installer still ships create-github-pr.sh', t => {
	const installers = [
		path.resolve(import.meta.dirname, '../install.sh'),
		// The monorepo installer enumerates the dow helper scripts by name;
		// a stale entry there is a silent copy failure at install time.
		path.resolve(import.meta.dirname, '../../../install.sh'),
	].filter(p => fs.existsSync(p));

	t.true(installers.length > 0, 'expected at least one installer to check');
	for (const installer of installers) {
		t.false(
			fs.readFileSync(installer, 'utf-8').includes('create-github-pr.sh'),
			`${installer} must not copy a script that no longer exists`,
		);
	}
});

test('provider-helpers.sh defines no create_pr helper', t => {
	const helpers = readScript('provider-helpers.sh');
	t.notRegex(
		helpers,
		/^\s*create_pr\s*\(\)/m,
		'create_pr() must not be reintroduced',
	);
});

test('provider-helpers.sh keeps check_existing_pr for both providers', t => {
	const helpers = readScript('provider-helpers.sh');
	// Reprovisioning an issue that already has a PR must still resolve
	// ${PR_URL} for links/keybindings — only *creation* was removed.
	t.regex(helpers, /^\s*check_existing_pr\s*\(\)/m);
	t.true(helpers.includes('gh pr view'));
	t.true(helpers.includes('glab mr view'));
});

/**
 * Runs `check_existing_pr` with a stubbed `gh` on PATH.
 * @param ghScript - body of the fake `gh`; `$@` is the real arg list.
 */
function runCheckExistingPr(ghScript: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappa-check-pr-'));
	try {
		const gh = path.join(dir, 'gh');
		fs.writeFileSync(gh, `#!/bin/bash\n${ghScript}\n`);
		fs.chmodSync(gh, 0o755);
		const config = path.join(dir, '.pappardelle.yml');
		fs.writeFileSync(config, 'version: 1\n');
		return execFileSync(
			'bash',
			[
				'-c',
				`source "${path.join(
					scriptsDir,
					'provider-helpers.sh',
				)}"; check_existing_pr "${config}"`,
			],
			{
				encoding: 'utf-8',
				env: {...process.env, PATH: `${dir}:${process.env.PATH!}`},
			},
		).trim();
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
}

test('check_existing_pr returns a real PR URL', t => {
	t.is(
		runCheckExistingPr('echo https://github.com/o/r/pull/7'),
		'https://github.com/o/r/pull/7',
	);
});

test('check_existing_pr returns empty when gh reports no PR', t => {
	t.is(
		runCheckExistingPr(
			'echo "no pull requests found for branch \\"STA-1\\"" >&2; exit 1',
		),
		'',
	);
});

test('check_existing_pr never leaks a gh error as a PR URL', t => {
	// This is now the *only* PR-resolution path (STA-1866), so anything that
	// isn't a URL must come back empty rather than getting piped into
	// `${PR_URL}` and opened in a browser. Reproduced live against a repo whose
	// origin is not a GitHub host.
	for (const failure of [
		'echo "none of the git remotes configured for this repository point to a known GitHub host." >&2; exit 1',
		'echo "gh: Not Found (HTTP 404)" >&2; exit 1',
		'echo "error connecting to api.github.com" >&2; exit 1',
		'exit 4', // auth failure, silent
	]) {
		t.is(runCheckExistingPr(failure), '', `leaked output for: ${failure}`);
	}
});

test('provisioning never pushes or commits on the user behalf', t => {
	for (const name of ['idow', 'provider-helpers.sh', 'create-worktree.sh']) {
		const script = readScript(name);
		t.false(
			script.includes('git push'),
			`${name} must not push during provisioning`,
		);
		t.false(
			script.includes('--allow-empty'),
			`${name} must not create a placeholder commit`,
		);
		t.false(
			script.includes('git reset HEAD~1'),
			`${name} must not rewrite local history to hide a placeholder commit`,
		);
	}
});

test('idow does not call create_pr', t => {
	const idow = readScript('idow');
	t.false(idow.includes('create_pr'));
});

test('idow still resolves PR_URL from an existing PR', t => {
	const idow = readScript('idow');
	// ${PR_URL} template expansion and `if_set: PR_URL` link gating both
	// depend on this lookup surviving the removal.
	t.true(idow.includes('check_existing_pr'));
	t.true(idow.includes(String.raw`\$\{PR_URL\}`));
	t.true(idow.includes('PR_URL|MR_URL'));
});

test('shipped PR-dependent keybindings guard against "no PR yet"', t => {
	const configs = [
		path.resolve(import.meta.dirname, '../examples/monorepo-pappardelle.yml'),
		path.resolve(import.meta.dirname, '../pappardelle.example.yml'),
		path.resolve(import.meta.dirname, '../../../../.pappardelle.yml'),
	].filter(p => fs.existsSync(p));

	let checked = 0;
	for (const file of configs) {
		const yml = fs.readFileSync(file, 'utf-8');
		for (const [i, line] of yml.split('\n').entries()) {
			if (!line.includes('gh pr list --search')) continue;
			checked++;
			// jq's `.[0].number` on an empty array yields the string "null",
			// which sails straight into `gh workflow run -f pr_number=null`.
			// Every PR-consuming binding must resolve to the empty string and
			// branch on it instead.
			t.true(
				line.includes('// empty'),
				`${path.basename(file)}:${i + 1} must fall back to empty, not "null"`,
			);
			// YAML double-quoted scalars escape the inner quotes as \"
			t.regex(
				line,
				/if \[ -[nz] \\?"\$PR_(NUM|URL)\\?" \]/,
				`${path.basename(file)}:${i + 1} must branch on the no-PR case`,
			);
		}
	}

	// Guards against the test silently passing with zero assertions if the
	// bindings are ever renamed out from under the `gh pr list --search` probe.
	t.true(checked > 0, 'expected at least one PR-resolving keybinding to check');
});

test('CI no longer carries placeholder-PR detection', t => {
	const workflowsDir = path.resolve(
		import.meta.dirname,
		'../../../../.github/workflows',
	);
	// Only meaningful inside the stardust-labs monorepo. The standalone
	// pappardelle repo HAS a .github/workflows dir (test.yml) but none of
	// these files — so probe for the files themselves, and keep the t.pass()
	// fallback so ava doesn't fail the test for having zero assertions there.
	const workflows = ['claude-code-review.yml', 'standard_lint.yml']
		.map(name => path.join(workflowsDir, name))
		.filter(file => fs.existsSync(file));

	if (workflows.length === 0) {
		t.pass('not running in the monorepo');
		return;
	}

	for (const file of workflows) {
		const name = path.basename(file);
		const workflow = fs.readFileSync(file, 'utf-8');
		t.false(
			workflow.includes('is_placeholder'),
			`${name} must not gate on placeholder detection`,
		);
		t.false(
			workflow.includes('changedFiles'),
			`${name} must not probe changedFiles to detect placeholders`,
		);
	}
});
