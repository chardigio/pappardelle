import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {render} from '../test/helpers/opentui-render.ts';
import App from '../source/app.tsx';
import {getRepoName} from '../source/config.ts';
import {getRecentErrors} from '../source/logger.ts';
import {getRegistryPathForRepo} from '../source/space-registry.ts';
import {createStateDaos} from '../source/state-daos.ts';
import {
	createIssueTracker,
	createVcsHost,
	resetProviders,
} from '../source/providers/index.ts';
import {initTmuxState} from '../source/tmux.ts';
import type {TrackerIssue} from '../source/providers/types.ts';
import {StatusHarness, until} from './program-status-harness.ts';

// The rail over a state.db that SQLite refuses to open: it has to draw, list
// no space it cannot read, report the problem, and list the space once the
// database can be read, without being started again.

const harness = new StatusHarness();
const originalDirectory = process.cwd();
const key = 'fixture-1';
let view: Awaited<ReturnType<typeof render>> | undefined;
const frame = async () => {
	await view!.renderOnce();
	return view!.lastFrame();
};

try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	const repo = getRepoName();
	writeFileSync(
		path.join(harness.root, '.pappardelle.yml'),
		'version: 1\ndefault_profile: fixture\nprofiles:\n  fixture:\n    display_name: Fixture\n    keywords: []\n',
	);
	const stateDir = path.join(harness.root, 'state');
	const registry = getRegistryPathForRepo(repo, stateDir);
	mkdirSync(path.dirname(registry), {recursive: true});
	writeFileSync(registry, JSON.stringify([key]));
	const dbPath = path.join(stateDir, 'state.db');
	writeFileSync(dbPath, 'not a database '.repeat(600));
	const daos = createStateDaos({repo, stateDir, sqlite: true});
	initTmuxState(daos);
	const issue: TrackerIssue = {
		identifier: key,
		title: 'Unreadable state fixture',
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
	view = await render(
		React.createElement(App, {
			daos,
			paneLayout: null,
			commitSha: 'fixture',
			installedVersion: null,
		}),
	);

	const refreshFailed = () =>
		getRecentErrors().some(
			entry =>
				entry.component === 'app' &&
				entry.message === 'Failed to refresh workspaces',
		);
	const unreadable = await until(
		frame,
		current => current.includes(repo) && refreshFailed(),
		'the rail draws and reports the registry it could not read',
	);
	assert.ok(!unreadable.includes('Unable to render this view'), unreadable);
	assert.ok(!unreadable.includes(key), unreadable);
	console.log('PASS actual App: draws the rail over an unreadable database');

	rmSync(dbPath);
	const readable = await until(
		frame,
		current => current.includes(key),
		'the space is listed once the database can be read',
		20_000,
	);
	assert.ok(!readable.includes('Unable to render this view'), readable);
	console.log('PASS actual App: lists the space once the database is readable');
} catch (error) {
	console.error(view?.lastFrame());
	throw error;
} finally {
	view?.unmount();
	resetProviders();
	process.chdir(originalDirectory);
	await harness.cleanup();
}
