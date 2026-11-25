import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';

test('slow gh/glab lookups keep timers running and opening an MR never fetches a diff', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pappardelle-slow-vcs-'));
	teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
	for (const command of ['gh', 'glab']) {
		fs.writeFileSync(
			path.join(dir, command),
			`#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.VCS_CALLS, JSON.stringify({command: ${JSON.stringify(command)}, args, host: process.env.GITLAB_HOST}) + '\\n');
setTimeout(() => {
  if (${JSON.stringify(command)} === 'glab') {
    if (args[1] !== 'list') process.exit(20);
    console.log(JSON.stringify([{iid: 7, web_url: 'https://' + process.env.GITLAB_HOST + '/team/project/-/merge_requests/7'}]));
  } else if (args[0] === 'repo') {
    console.log('fork-owner/repo');
  } else {
    const pr = {number: 26, url: 'https://github.com/upstream/repo/pull/26', changedFiles: 1};
    console.log(JSON.stringify({data: {search: {nodes: [pr]}, pr0: {nodes: [pr]}}}));
  }
}, 150);
`,
			{mode: 0o755},
		);
	}
	const githubUrl = new URL('providers/github-provider.ts', import.meta.url)
		.href;
	const gitlabUrl = new URL('providers/gitlab-provider.ts', import.meta.url)
		.href;
	const openUrl = new URL('open-pr.ts', import.meta.url).href;
	const script = `
import {GitHubProvider} from ${JSON.stringify(githubUrl)};
import {GitLabProvider} from ${JSON.stringify(gitlabUrl)};
import {openPR} from ${JSON.stringify(openUrl)};
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const gh = new GitHubProvider();
const glab = new GitLabProvider('gitlab.fixture.test');
const opened = [];
const messages = [];
const options = {isLatest: () => true, ownsHeader: () => true, openUrl: async url => { opened.push(url); }, showMessage: msg => messages.push(msg)};
const start = ticks;
const results = await Promise.all([
  openPR('STA-1', {...options, provider: gh}).then(() => ticks - start),
  gh.getBulkRailStatus(['STA-1']).then(result => ({ticks: ticks - start, number: result.get('STA-1').prNumber})),
  openPR('STA-2', {...options, provider: glab}).then(() => ticks - start),
]);
clearInterval(timer);
console.log(JSON.stringify({results, opened, messages, host: process.env.GITLAB_HOST}));
`;
	const callsFile = path.join(dir, 'calls');
	const {stdout} = await promisify(execFile)(
		process.execPath,
		['--input-type=module', '-e', script],
		{
			env: {
				...process.env,
				PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
				VCS_CALLS: callsFile,
				GITLAB_HOST: 'original.fixture.test',
			},
			timeout: 15_000,
		},
	);
	const result = JSON.parse(stdout) as {
		results: [number, {ticks: number; number: number}, number];
		opened: string[];
		messages: string[];
		host: string;
	};
	expect(result.results[0] >= 10).toBe(true);
	expect(result.results[1].ticks >= 10).toBe(true);
	expect(result.results[2] >= 5).toBe(true);
	expect(result.results[1].number).toBe(26);
	expect(result.opened.sort()).toStrictEqual(
		[
			'https://github.com/upstream/repo/pull/26',
			'https://gitlab.fixture.test/team/project/-/merge_requests/7',
		].sort(),
	);
	expect(result.messages.sort()).toStrictEqual([
		'Opened PR #26',
		'Opened PR #7',
	]);
	expect(result.host).toBe('original.fixture.test');
	const calls = fs
		.readFileSync(callsFile, 'utf8')
		.trim()
		.split('\n')
		.map(
			line =>
				JSON.parse(line) as {command: string; args: string[]; host: string},
		);
	expect(
		calls.filter(call => call.command === 'gh' && call.args[0] === 'repo')
			.length,
	).toBe(1);
	const glabCalls = calls.filter(call => call.command === 'glab');
	expect(glabCalls.length).toBe(1);
	expect(glabCalls[0]!.args[1]).toBe('list');
	expect(glabCalls[0]!.host).toBe('gitlab.fixture.test');
});
