import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {render} from 'ink-testing-library';
import App from '../source/app.tsx';
import {
	getRepoName,
	getResolvedWatchlists,
	loadConfig,
} from '../source/config.ts';
import {setRegistryPath, resetRegistryPath} from '../source/space-registry.ts';
import {
	createIssueTracker,
	createVcsHost,
	resetProviders,
} from '../source/providers/index.ts';
import {getSessionNames} from '../source/tmux.ts';
import {
	attachStatusMonitor,
	statusShellCommand,
} from '../source/program-status-monitor.ts';
import {StatusHarness, until} from './program-status-harness.ts';
import type {TrackerIssue} from '../source/providers/types.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const key = 'fixture-1';
let view: ReturnType<typeof render> | undefined;
let repo: string | undefined;
try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	repo = getRepoName();
	writeFileSync(
		path.join(harness.root, '.pappardelle.yml'),
		'version: 1\ndefault_profile: fixture\nprofiles:\n  fixture:\n    display_name: Fixture\n    keywords: []\n',
	);
	assert.equal(
		getResolvedWatchlists(loadConfig()).length,
		0,
		'Full app verification requires no automatic watchlists',
	);
	const registry = path.join(harness.root, 'open-spaces.json');
	writeFileSync(registry, JSON.stringify([key]));
	setRegistryPath(registry);
	const issue: TrackerIssue = {
		identifier: key,
		title: 'Terminal status fixture',
		state: {name: 'Open', type: 'unstarted', color: 'gray'},
	};
	const tracker = createIssueTracker({provider: 'beads'});
	tracker.getIssue = async candidate => (candidate === key ? issue : null);
	tracker.getIssueCached = candidate => (candidate === key ? issue : null);
	tracker.getIssues = async candidates =>
		new Map(
			candidates.map(candidate => [
				candidate,
				candidate === key ? issue : null,
			]),
		);
	const vcs = createVcsHost();
	vcs.getBulkRailStatus = async () => new Map();
	const session = getSessionNames(key, repo).claude;
	await harness.tmux([
		'new-session',
		'-d',
		'-s',
		session,
		'-c',
		harness.root,
		statusShellCommand(),
	]);
	await attachStatusMonitor(repo, key, session);
	await harness.fixture(session);
	view = render(
		React.createElement(App, {
			paneLayout: null,
			commitSha: 'fixture',
			installedVersion: null,
		}),
	);
	const frames: Array<{scenario: string; frame: string}> = [];
	async function expect(icon: string, scenario: string) {
		const frame = await until(
			() => view?.lastFrame() ?? '',
			current => current.includes(`${icon} ${key}`),
			scenario,
		);
		frames.push({scenario, frame});
		console.log(`PASS actual App: ${scenario}`);
	}
	await expect('●', 'initial persisted native idle');
	await harness.emit(session, 'state=working:app=fixture');
	await harness.emit(session, 'state=blocked:id=child:kind=question');
	await expect('?', 'child question reaches App watcher and WorkspaceRefresh');
	await harness.emit(session, 'state=clear:id=child');
	await harness.emit(session, 'state=blocked:app=fixture:kind=auth');
	await expect('!', 'authentication receives attention treatment');
	await harness.emit(session, 'state=done:app=fixture');
	await expect('●', 'done displays completion while tracker remains open');
	assert.ok(view.lastFrame()?.includes(key));
	writeFileSync(
		path.join(harness.root, 'app-verification.json'),
		JSON.stringify({frames}, null, 2),
	);
	console.log(
		`App evidence ${harness.root}/app-verification.json (--keep preserves it)`,
	);
} finally {
	view?.unmount();
	resetRegistryPath();
	resetProviders();
	process.chdir(originalDirectory);
	await harness.cleanup(repo, key);
	if (repo)
		rmSync(path.join(homedir(), '.pappardelle', 'repos', repo), {
			recursive: true,
			force: true,
		});
}
