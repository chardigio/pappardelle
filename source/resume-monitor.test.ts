import {tokenHash} from './resume-records-sqlite.ts';
import {Buffer} from 'node:buffer';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test, expect} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import type {ProcessInfo} from './process-tree.ts';
import type {ResumeState} from './program-resume.ts';
import {watchResume, type ResumeWatchDeps} from './resume-monitor.ts';

const NOW = 1_795_543_200;
const agent = {kind: 'agent'} as const;
const report = (body: string, token: string) =>
	`${body}:mac=${createHash('sha256').update(`${body}:${token}`).digest('hex')}`;
const argv = `argv=${Buffer.from('claude').toString('base64')}`;

async function setup(
	state: ReturnType<NonNullable<ResumeWatchDeps['paneState']>> = 'server-gone',
	withToken = true,
	stored?: ResumeState,
) {
	const s = testState();
	const dao = s.daos.resumeRecords;
	await dao.commitLaunch('k', agent, tokenHash('tok'));
	if (stored) await dao.save('k', agent, tokenHash('tok'), stored);
	const tokenFile = path.join(tempDir('resume-monitor-'), 'monitor-token');
	if (withToken) writeFileSync(tokenFile, 'tok');
	const tree = new Map<number, ProcessInfo>([
		[10, {pid: 10, ppid: 1, uid: 501, started: 'a'}],
		[20, {pid: 20, ppid: 10, uid: 501, started: 'a'}],
	]);
	let clock = NOW * 1000;
	let checks = 0;
	const watcher = watchResume(
		{
			repo: 'repo',
			key: 'k',
			pane: agent,
			panePid: 10,
			tmuxPaneId: '%1',
			tmuxSocket: 's',
			monitorTokenFile: tokenFile,
			dbPath: '',
		},
		{
			dao,
			uid: 501,
			now: () => clock,
			inspector: {
				processes() {
					checks++;
					return new Map(tree);
				},
				cwd: () => '/repo',
			},
			timers: {after: () => () => {}},
			paneState: () => state,
		},
	);
	const flush = () => Bun.sleep(20);
	return {
		dao,
		watcher,
		flush,
		advance(ms: number) {
			clock += ms;
		},
		get checks() {
			return checks;
		},
	};
}

test('an accepted report is saved, and a closed pipe on a dead server keeps it', async () => {
	const f = await setup('server-gone');
	f.watcher.event({
		type: 'resume',
		body: report(`pid=20:time=${NOW}:${argv}`, 'tok'),
	});
	await f.flush();
	expect(f.dao.read('k', agent).records.map(each => each.argv)).toStrictEqual([
		['claude'],
	]);
	f.watcher.stop('eof');
	await f.flush();
	expect(f.dao.read('k', agent).records).toHaveLength(1);
});

test('a pane closed while the server still runs drops its records; a signal never does', async () => {
	for (const [state, why, kept] of [
		['pane-gone', 'eof', 0],
		['present', 'eof', 0],
		['pane-gone', 'signal', 1],
	] as const) {
		const f = await setup(state);
		f.watcher.event({
			type: 'resume',
			body: report(`pid=20:time=${NOW}:${argv}`, 'tok'),
		});
		await f.flush();
		f.watcher.stop(why);
		await f.flush();
		expect(f.dao.read('k', agent).records).toHaveLength(kept);
	}
});

test('a monitor with no token file records nothing', async () => {
	const f = await setup('pane-gone', false);
	f.watcher.event({
		type: 'resume',
		body: report(`pid=20:time=${NOW}:${argv}`, 'tok'),
	});
	f.watcher.stop('eof');
	await f.flush();
	expect(f.dao.read('k', agent).records).toHaveLength(0);
});

test("a monitor attached again keeps the launch's records and drops them when the pane closes", async () => {
	const stored = {
		records: [
			{
				pid: 20,
				started: 'a',
				uid: 501,
				depth: 1,
				time: NOW,
				argv: ['claude'],
				cwdSource: 'process' as const,
			},
		],
		times: {20: NOW},
	};
	for (const newerLaunch of [false, true]) {
		const f = await setup('pane-gone', false, stored);
		if (newerLaunch) {
			await f.dao.commitLaunch('k', agent, tokenHash('newer'));
			await f.dao.save('k', agent, tokenHash('newer'), stored);
		}
		f.watcher.stop('eof');
		await f.flush();
		expect(f.dao.read('k', agent).records).toHaveLength(newerLaunch ? 1 : 0);
	}
});

test('prompt marks check owners at most once a second', async () => {
	const f = await setup();
	f.watcher.event({
		type: 'resume',
		body: report(`pid=20:time=${NOW}:${argv}`, 'tok'),
	});
	const before = f.checks;
	for (let i = 0; i < 50; i++) f.watcher.event({type: 'prompt'});
	expect(f.checks - before).toBe(1);
	f.advance(1000);
	f.watcher.event({type: 'prompt'});
	expect(f.checks - before).toBe(2);
});
