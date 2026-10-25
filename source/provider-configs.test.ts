import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadProviderConfigs} from './config.ts';

function setupTempDir(files: Record<string, string>): {
	dir: string;
	cleanup: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-providers-'));
	for (const [name, content] of Object.entries(files)) {
		const filePath = path.join(dir, name);
		fs.mkdirSync(path.dirname(filePath), {recursive: true});
		fs.writeFileSync(filePath, content, 'utf-8');
	}

	return {
		dir,
		cleanup() {
			fs.rmSync(dir, {recursive: true, force: true});
		},
	};
}

// ============================================================================
// loadProviderConfigs — layered, validation-free provider lookup
// ============================================================================

test('loadProviderConfigs takes issue_tracker and vcs_host from the home layer', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
vcs_host:
  provider: gitlab
  host: gitlab.example.com
`,
		'project/.pappardelle.yml': `version: 1
profiles:
  api:
    display_name: API
`,
	});
	try {
		const cfg = loadProviderConfigs({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(cfg.issue_tracker?.provider, 'jira');
		t.is(cfg.issue_tracker?.base_url, 'https://example.atlassian.net');
		t.is(cfg.vcs_host?.provider, 'gitlab');
		t.is(cfg.vcs_host?.host, 'gitlab.example.com');
	} finally {
		cleanup();
	}
});

test('loadProviderConfigs lets project and local layers override home key by key', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
issue_tracker:
  provider: jira
  base_url: https://home.atlassian.net
vcs_host:
  provider: gitlab
  host: gitlab.home.example
`,
		'project/.pappardelle.yml': `version: 1
issue_tracker:
  base_url: https://project.atlassian.net
`,
		'project/.pappardelle.local.yml': `vcs_host:
  host: gitlab.local.example
`,
	});
	try {
		const cfg = loadProviderConfigs({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(cfg.issue_tracker?.provider, 'jira');
		t.is(cfg.issue_tracker?.base_url, 'https://project.atlassian.net');
		t.is(cfg.vcs_host?.provider, 'gitlab');
		t.is(cfg.vcs_host?.host, 'gitlab.local.example');
	} finally {
		cleanup();
	}
});

test('loadProviderConfigs ignores validation errors elsewhere and skips an unparseable layer', t => {
	const {dir, cleanup} = setupTempDir({
		'home/.pappardelle.yml': `version: 1
vcs_host:
  provider: gitlab
  host: gitlab.example.com
`,
		'project/.pappardelle.yml': `version: 1
issue_tracker:
  provider: beads
profiles:
  broken:
    keywords: not-a-list
`,
		'project/.pappardelle.local.yml': `vcs_host: [unclosed
`,
	});
	try {
		const cfg = loadProviderConfigs({
			homeConfigDir: path.join(dir, 'home'),
			projectDir: path.join(dir, 'project'),
		});
		t.is(cfg.issue_tracker?.provider, 'beads');
		t.is(cfg.vcs_host?.host, 'gitlab.example.com');
	} finally {
		cleanup();
	}
});

test('loadProviderConfigs returns empty when no layer exists', t => {
	const {dir, cleanup} = setupTempDir({});
	try {
		t.deepEqual(
			loadProviderConfigs({
				homeConfigDir: path.join(dir, 'home'),
				projectDir: path.join(dir, 'project'),
			}),
			{issue_tracker: undefined, vcs_host: undefined},
		);
	} finally {
		cleanup();
	}
});
