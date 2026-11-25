import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {render} from '../test/helpers/opentui-render.ts';
import App from '../source/app.tsx';
import {getRepoName} from '../source/config.ts';
import {getRegistryPathForRepo} from '../source/space-registry.ts';
import {createStateDaos, type StateDaos} from '../source/state-daos.ts';
import {initTmuxState} from '../source/tmux.ts';
import {
	createIssueTracker,
	createVcsHost,
	resetProviders,
} from '../source/providers/index.ts';
import type {TrackerIssue} from '../source/providers/types.ts';
import {StatusHarness, until} from './program-status-harness.ts';

const harness = new StatusHarness();
const originalDirectory = process.cwd();
let registry = '';
let daos: StateDaos | undefined;
const frames: Array<{scenario: string; frame: string}> = [];
let view: Awaited<ReturnType<typeof render>> | undefined;
let repo: string | undefined;

const issues = new Map<string, TrackerIssue>();
function seed(count: number, reviewEvery = 0) {
	issues.clear();
	const keys = Array.from(
		{length: count},
		(_, index) => `fixture-${index + 1}`,
	);
	for (const [index, key] of keys.entries()) {
		const inReview = reviewEvery > 0 && index % reviewEvery === 0;
		issues.set(key, {
			identifier: key,
			title: `Rail fixture ${index + 1}`,
			state: inReview
				? {name: 'In Review', type: 'started', color: 'magenta'}
				: {name: 'In Progress', type: 'started', color: 'blue'},
		});
	}

	writeFileSync(registry, JSON.stringify(keys));
}

// App sizes the rail from stdout, which is 80x40 when it is not a terminal.
async function mount(width = 80, height = 40) {
	view?.unmount();
	view = await render(
		React.createElement(App, {
			daos: daos!,
			paneLayout: null,
			commitSha: 'fixture',
			installedVersion: null,
		}),
		{width, height},
	);
	return view;
}

async function expectFrame(
	scenario: string,
	check: (lines: string[]) => boolean,
) {
	const frame = await until(
		() => view?.lastFrame() ?? '',
		current => check(current.split('\n')),
		scenario,
	);
	frames.push({scenario, frame});
	console.log(`PASS rail boxes: ${scenario}`);
	return frame.split('\n');
}

const topBorder = (lines: string[], title: string) =>
	lines.findIndex(line => line.startsWith(`╭─ ${title}`));

try {
	execFileSync('git', ['init', '--quiet', harness.root]);
	process.chdir(harness.root);
	repo = getRepoName();
	writeFileSync(
		path.join(harness.root, '.pappardelle.yml'),
		'version: 1\ndefault_profile: fixture\nlist_view:\n  group_by: status\nprofiles:\n  fixture:\n    display_name: Fixture\n    keywords: []\n',
	);
	const stateDir = path.join(harness.root, 'state');
	registry = getRegistryPathForRepo(repo, stateDir);
	mkdirSync(path.dirname(registry), {recursive: true});
	daos = createStateDaos({
		repo,
		stateDir,
		sqlite: harness.sqlite,
	});
	initTmuxState(daos);
	const tracker = createIssueTracker({provider: 'beads'});
	tracker.getIssue = async key => issues.get(key) ?? null;
	tracker.getIssueCached = key => issues.get(key) ?? null;
	tracker.getIssues = async keys =>
		new Map(keys.map(key => [key, issues.get(key) ?? null]));
	const vcs = createVcsHost();
	vcs.getBulkRailStatus = async () => new Map();

	seed(3, 3);
	await mount();
	const split = await expectFrame(
		'two boxes: the workspace in the top border, spaces counted in the rail border',
		lines =>
			topBorder(lines, `🍝 ${repo}`) === 0 &&
			lines.some(
				line => line.startsWith('╭─ rail') && line.endsWith(' 3 spaces ─╮'),
			) &&
			lines.some(line => line.includes('fixture-3')),
	);
	// Frame, status row, then the sous-chef row.
	assert.match(split[1]!, /^│\s+│$/, 'status row is reserved above the agents');
	assert.match(split[2]!, /main/, 'agent row follows the status row');
	assert.match(split[3]!, /^╰─+╯$/, 'workspace box closes after the agents');
	assert.equal(topBorder(split, 'rail'), 4, 'rail box sits right below');
	assert.ok(
		split.some(line => line.includes('In Progress (2)')),
		'rail box keeps the group headers',
	);
	assert.ok(!split.some(line => line.startsWith('├')), 'no divider');

	await view!.stdin.write('/');
	await view!.stdin.write('fixture-2');
	const search = await expectFrame(
		'search merges the boxes into one flat list with the match count',
		lines =>
			lines[0]!.endsWith(' 1 match ─╮') &&
			topBorder(lines, 'rail') === -1 &&
			lines.some(line => line.includes('fixture-2')),
	);
	assert.ok(
		!search.some(line => line.includes('In Progress (')),
		'search has no group headers',
	);
	assert.match(search[1]!, /\/ fixture-2/, 'search row leads the box');
	await view!.stdin.write('zzz');
	await expectFrame(
		'no matches: the body says so and the border has no count',
		lines =>
			lines.some(line => line.includes('No matches.')) &&
			/^╭─ 🍝 [^─]*─+╮$/.test(lines[0]!),
	);
	await view!.stdin.write('\u001B');
	await expectFrame(
		'escape restores both boxes',
		lines => topBorder(lines, 'rail') > 0,
	);
	// Regression check: the search row's input takes over typing mid-write.
	await view!.stdin.write('/fixture-2');
	await expectFrame(
		'a search typed in one write keeps each character once',
		lines =>
			/\/ fixture-2 *│$/.test(lines[1]!) && lines[0]!.endsWith(' 1 match ─╮'),
	);
	await view!.stdin.write('\u001B');
	await expectFrame(
		'escape restores both boxes after a one-write search',
		lines => topBorder(lines, 'rail') > 0,
	);
	// A dialog opened by a key takes the rest of the write: the second ? closes
	// the help the first one opened.
	await view!.stdin.write('??');
	await expectFrame(
		'help opened and closed in one write leaves the rail',
		lines =>
			topBorder(lines, 'rail') > 0 &&
			!lines.some(line => line.includes('Keyboard Shortcuts')),
	);

	// A click is not a key, so it is committed before the key after it in the
	// same write only if its handler commits it.
	const rows = view!.lastFrame().split('\n');
	const clicked = rows.findIndex(line => line.includes('fixture-1'));
	assert.ok(clicked > 0, 'fixture-1 row is on screen');
	const click = `\u001B[<0;6;${clicked + 1}M\u001B[<0;6;${clicked + 1}m`;
	await view!.stdin.write(click + 'x');
	await expectFrame(
		'a click then x in one write closes the clicked space',
		lines => lines.some(line => line.includes('Close space fixture-1?')),
	);
	await view!.stdin.write('\u001B');

	seed(60);
	await mount();
	await expectFrame('a long list shows its range in the rail border', lines =>
		lines.some(line => /^╭─ rail.* 1-\d+ of 60 ─╮$/.test(line)),
	);
	for (let step = 0; step < 50; step++) await view!.stdin.write('j');
	const scrolled = await expectFrame(
		'scrolling moves the range and keeps the agent rows in view',
		lines =>
			lines.some(line => /^╭─ rail.* (?!1-)\d+-\d+ of 60 ─╮$/.test(line)),
	);
	assert.match(scrolled[2]!, /main/, 'sous-chef row stays put while scrolling');

	seed(0);
	await mount();
	const empty = await expectFrame(
		'no workspaces: no count in the rail border',
		lines => lines.some(line => line.includes('No spaces found')),
	);
	assert.match(
		empty[topBorder(empty, 'rail')]!,
		/^╭─ rail ─+╮$/,
		'rail border has no count',
	);

	writeFileSync(
		path.join(harness.root, 'rail-boxes.json'),
		JSON.stringify({frames}, null, 2),
	);
	console.log(
		`Rail evidence ${harness.root}/rail-boxes.json (--keep preserves it)`,
	);
} catch (error) {
	console.error(view?.lastFrame());
	throw error;
} finally {
	view?.unmount();
	resetProviders();
	process.chdir(originalDirectory);
	await harness.cleanup();
	if (repo)
		rmSync(path.join(homedir(), '.pappardelle', 'repos', repo), {
			recursive: true,
			force: true,
		});
}
