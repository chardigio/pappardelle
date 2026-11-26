import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import type {ClaudeSessionState} from './claude-status.ts';
import type {PappardelleConfig} from './config.ts';
import {
	parseStatusPane,
	type ProgramStatusSnapshot,
	type StatusPane,
} from './program-status-monitor.ts';
import {newSpaceIdentity} from './space-identity.ts';
import {claudeProjectDir} from './space-state.ts';
import {
	formatSpaces,
	gatherSpaces,
	parseShortstat,
	worktreeGitSummary,
	type SpaceEntry,
	type SpacesDeps,
} from './spaces-command.ts';
import {
	claudeStatusFile,
	sqliteRun,
	testState,
	writeClaudeStatus,
	type TestState,
} from '../test/helpers/state.ts';

const REPO = 'test-repo';

const states = new Map<string, TestState>();

function tempHome(
	options: {sqlite?: boolean; clock?: () => Date} = {},
): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-spaces-'));
	teardown(() => {
		states.delete(home);
		fs.rmSync(home, {recursive: true, force: true});
	});
	states.set(
		home,
		testState({
			repo: REPO,
			stateDir: path.join(home, '.pappardelle'),
			home,
			...options,
		}),
	);
	return home;
}

/** The stores a process run with this home directory would read. */
const stores = (home: string) => states.get(home)!.daos;

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(
		file,
		typeof data === 'string' ? data : JSON.stringify(data),
	);
}

const repoState = (home: string, ...rest: string[]) =>
	path.join(home, '.pappardelle', 'repos', REPO, ...rest);

const statusKey = (key: string, repo = REPO) => `${repo}-${key}`;

/** A status as the hook reports it. */
async function writeStatus(
	home: string,
	workspaceName: string,
	state: Partial<ClaudeSessionState> &
		Pick<ClaudeSessionState, 'status' | 'lastUpdate'>,
): Promise<void> {
	await writeClaudeStatus(states.get(home)!, {
		sessionId: 'session',
		workspaceName,
		...state,
	});
}

function openSpaces(home: string, keys: string[]): void {
	writeJson(repoState(home, 'open-spaces.json'), keys);
}

async function gather(
	home: string,
	overrides: Partial<SpacesDeps> = {},
): Promise<SpaceEntry[]> {
	const report = await gatherSpaces({
		repoName: REPO,
		...stores(home),
		home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
		...overrides,
	});
	if ('error' in report) throw new Error(report.error);
	return report.spaces;
}

test('a repo with no open-spaces file reports the error', async () => {
	const home = tempHome();
	expect(
		await gatherSpaces({
			repoName: REPO,
			...stores(home),
			home,
			fetchTitles: async () => new Map(),
			gitSummary: async () => null,
		}),
	).toStrictEqual({error: 'No open spaces file found', spaces: []});
});

test('a registry that cannot be read reports the failure and its cause, not that there are no spaces', async () => {
	const home = tempHome();
	writeJson(repoState(home, 'open-spaces.json'), '{"not": "a list"}');
	const report = await gatherSpaces({
		repoName: REPO,
		...stores(home),
		home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
	});
	expect(report.spaces).toStrictEqual([]);
	expect((report as {error: string}).error).toMatch(
		sqliteRun
			? /^Could not read the open spaces: .*open-spaces\.json could not be imported \(malformed\)$/
			: /^Could not read the open spaces: Invalid workspace registry$/,
	);
});

test('status is what the hook last recorded, however old', async () => {
	const home = tempHome();
	const now = Date.now();
	openSpaces(home, ['STA-100', 'STA-200']);
	await writeStatus(home, statusKey('STA-100'), {
		status: 'processing',
		currentTool: 'Bash',
		// Older than the TUI's active-status timeout; the board still sees it.
		lastUpdate: now - 3 * 60 * 60_000,
		sessionId: 'sess-abc',
	});
	const spaces = await gather(home, {now});
	const byName = new Map(spaces.map(space => [space.name, space]));
	expect(byName.get('STA-100')).toMatchObject({
		status: 'processing',
		currentTool: 'Bash',
		sessionId: 'sess-abc',
		minutesAgo: 180,
	});
	expect(byName.get('STA-200')?.status).toBe('no_status');
});

test('a status file that cannot be read is unknown, not missing', async () => {
	const home = tempHome({sqlite: false});
	openSpaces(home, ['STA-700']);
	writeJson(
		claudeStatusFile(states.get(home)!, statusKey('STA-700')),
		'not json{{{',
	);
	const [space] = await gather(home);
	expect(space?.status).toBe('unknown');
});

test('another repo with a space of the same key does not supply its status', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-1']);
	await writeStatus(home, statusKey('STA-1', 'other-repo'), {
		status: 'waiting_for_approval',
		lastUpdate: Date.now(),
	});
	const before = await gather(home);
	expect(before[0]?.status).toBe('no_status');
	await writeStatus(home, statusKey('STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	expect(after[0]?.status).toBe('ended');
});

test('metadata, rail state and the newest PR link are included', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-350']);
	const meta = {
		created_by_pappardelle: true,
		created_at: '2026-04-21T04:00:00Z',
	};
	writeJson(repoState(home, 'issue-meta', 'STA-350.json'), meta);
	const link = (number: number) => ({
		host: 'example.com',
		project: 'user/repo',
		localBranch: `branch-${number}`,
		remoteBranch: 'published',
		url: `https://example.com/pr/${number}`,
		number,
	});
	writeJson(repoState(home, 'space-state', 'STA-350.json'), {
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		updatedAt: '2026-04-21T05:00:00.000Z',
		prLinks: [link(1), link(2)],
	});
	const [space] = await gather(home);
	expect(space).toMatchObject({
		meta,
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		spaceStateUpdatedAt: '2026-04-21T05:00:00.000Z',
		prUrl: 'https://example.com/pr/2',
	});
});

test('rail fields are absent without a readable space-state file', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-360', 'STA-370']);
	writeJson(repoState(home, 'space-state', 'STA-370.json'), 'not json{{{');
	for (const space of await gather(home)) {
		expect('pipeline' in space).toBe(false);
		expect('recap' in space).toBe(false);
		expect(space.prUrl).toBe(null);
	}
});

// The board reads this report. With the database a space's state is only
// rewritten when it changes, so `spaceStateUpdatedAt` is the one field that
// may differ: the time of the last change, not of the last poll.
test('the report is the same from files and from the database for the same history', async () => {
	const report = async (sqlite: boolean) => {
		let now = '2026-04-21T05:00:00.000Z';
		const home = tempHome({sqlite, clock: () => new Date(now)});
		const daos = stores(home);
		openSpaces(home, ['NEW-1', 'OLD-2', 'IDLE-3']);
		await daos.issueMeta.markCreated('NEW-1');
		await daos.spaceState.write('NEW-1', {profile: 'dev'});
		await daos.spaceState.write('IDLE-3', {profile: 'dev'});
		const poll = async () =>
			daos.spaceState.writeMany([
				{
					key: 'NEW-1',
					patch: {
						pipeline: 'failing',
						unresolvedCommentCount: 4,
						prNumber: 777,
						hasConflict: true,
						recap: {customTitle: 'refactor auth', lastPrompt: 'go on'},
					},
				},
				{
					key: 'OLD-2',
					patch: {
						pipeline: null,
						unresolvedCommentCount: 0,
						prNumber: undefined,
						hasConflict: false,
					},
				},
			]);
		await poll();
		await daos.spaceState.addPrLink('NEW-1', {
			host: 'github.com',
			project: 'user/repo',
			localBranch: 'NEW-1',
			remoteBranch: 'published',
			url: 'https://github.com/user/repo/pull/777',
			number: 777,
		});
		now = '2026-04-21T06:00:00.000Z';
		await poll();
		const spaces = await gather(home, {now: 0});
		return {
			updatedAt: Object.fromEntries(
				spaces.map(space => [space.name, space.spaceStateUpdatedAt]),
			),
			rest: spaces.map(({spaceStateUpdatedAt, ...rest}) => rest),
		};
	};

	const files = await report(false);
	const database = await report(true);
	expect(database.rest).toStrictEqual(files.rest);
	expect(files.rest.find(space => space.name === 'NEW-1')).toMatchObject({
		meta: {created_by_pappardelle: true, created_at: '2026-04-21T05:00:00Z'},
		pipeline: 'failing',
		prNumber: 777,
		prUrl: 'https://github.com/user/repo/pull/777',
	});
	const polledWithoutPr = files.rest.find(space => space.name === 'OLD-2')!;
	expect(polledWithoutPr.pipeline).toBe(null);
	expect('prNumber' in polledWithoutPr).toBe(false);
	expect('pipeline' in files.rest.find(space => space.name === 'IDLE-3')!).toBe(
		false,
	);
	expect(files.updatedAt).toStrictEqual({
		'NEW-1': '2026-04-21T06:00:00.000Z',
		'OLD-2': '2026-04-21T06:00:00.000Z',
		'IDLE-3': '2026-04-21T05:00:00.000Z',
	});
	expect(database.updatedAt).toStrictEqual({
		'NEW-1': '2026-04-21T05:00:00.000Z',
		'OLD-2': '2026-04-21T05:00:00.000Z',
		'IDLE-3': '2026-04-21T05:00:00.000Z',
	});
});

test('a session belongs to the space whose stored worktree holds it', async () => {
	const home = tempHome({sqlite: true});
	const worktree = path.join(home, 'checkouts', 'login');
	await stores(home).spaceIdentities.record({
		repo: REPO,
		key: 'STA-410',
		worktreePath: worktree,
		tmux: {
			socket: 'pappardelle_inner',
			agentSession: `agent-${REPO}-STA-410`,
			companionSession: `companion-${REPO}-STA-410`,
		},
	});
	openSpaces(home, ['STA-410']);
	writeJson(path.join(home, '.claude', 'sessions', 'login.json'), {
		pid: 33_333,
		cwd: `${worktree}/src`,
	});
	const [space] = await gather(home);
	expect(space!.pid).toBe(33_333);
});

test('sessions match on the full worktree prefix and the newest wins', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-400', 'STA-500']);
	const sessions = path.join(home, '.claude', 'sessions');
	writeJson(path.join(sessions, 'stale.json'), {
		pid: 11_111,
		cwd: `${home}/.worktrees/${REPO}/STA-400`,
		startedAt: '2026-01-01T00:00:00Z',
	});
	writeJson(path.join(sessions, 'fresh.json'), {
		pid: 22_222,
		cwd: `${home}/.worktrees/${REPO}/STA-400/sub`,
		startedAt: '2026-04-01T00:00:00Z',
	});
	writeJson(path.join(sessions, 'other-repo.json'), {
		pid: 99_999,
		cwd: `${home}/.worktrees/${REPO}-api/STA-500`,
	});
	const spaces = await gather(home);
	const byName = new Map(spaces.map(s => [s.name, s]));
	expect(byName.get('STA-400')?.pid).toBe(22_222);
	expect(byName.get('STA-500')?.pid).toBe(undefined);
});

test('the newest top-level jsonl is the conversation log', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-800']);
	const encoded = `${home}/.worktrees/${REPO}/STA-800`
		.replaceAll('/', '-')
		.replaceAll('.', '-');
	const dir = path.join(home, '.claude', 'projects', encoded);
	writeJson(path.join(dir, 'old.jsonl'), '{}');
	writeJson(path.join(dir, 'new.jsonl'), '{}');
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(dir, 'old.jsonl'), past, past);
	const [space] = await gather(home);
	expect(space!.conversationLog).toBe(path.join(dir, 'new.jsonl'));
	expect(typeof space!.logMinutesAgo).toBe('number');
});

test('spaces sort by last update and carry tmux session names', async () => {
	const home = tempHome();
	const now = Date.now();
	openSpaces(home, ['STA-OLD', 'STA-NEW', 'a.b_c']);
	const status = async (key: string, ago: number) =>
		writeStatus(home, statusKey(key), {
			status: 'ended',
			lastUpdate: now - ago,
		});
	await status('STA-OLD', 60_000);
	await status('STA-NEW', 0);
	const spaces = await gather(home, {now});
	expect(spaces.map(s => s.name)).toStrictEqual([
		'STA-NEW',
		'STA-OLD',
		'a.b_c',
	]);
	expect(spaces[2]!.tmuxSession).toBe(`agent-${REPO}-a_b__c`);
});

test('titles come from the tracker, and null when it fails or is slow', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-1']);
	const [found] = await gather(home, {
		fetchTitles: async () => new Map([['STA-1', 'Fix auth']]),
	});
	expect(found!.title).toBe('Fix auth');
	const [failed] = await gather(home, {
		async fetchTitles() {
			throw new Error('offline');
		},
	});
	expect(failed!.title).toBe(null);
	const [slow] = await gather(home, {
		titleTimeoutMs: 20,
		fetchTitles: async () =>
			new Promise(resolve => {
				setTimeout(() => {
					resolve(new Map([['STA-1', 'late']]));
				}, 500);
			}),
	});
	expect(slow!.title).toBe(null);
});

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@t',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@t',
		},
	});
}

test('the git summary counts commits ahead of main and the diff since the branch point', async () => {
	const home = tempHome();
	const repo = path.join(home, 'repo');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'main');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'base');
	git(repo, 'checkout', '-qb', 'work');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
	git(repo, 'commit', '-qam', 'two');
	fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'b');
	// Upstream moves on after the branch point; it must not count.
	git(repo, 'checkout', '-q', 'main');
	fs.writeFileSync(path.join(repo, 'c.txt'), 'upstream\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-qm', 'upstream');
	git(repo, 'checkout', '-q', 'work');
	fs.writeFileSync(path.join(repo, 'new.txt'), 'not added\n');
	expect(await worktreeGitSummary(repo)).toStrictEqual({
		base: 'main',
		ahead: 2,
		filesChanged: 2,
		insertions: 2,
		deletions: 0,
		untracked: 1,
	});
});

test('parseShortstat reads each count, singular or plural, and missing ones as 0', () => {
	expect(
		parseShortstat(' 3 files changed, 120 insertions(+), 45 deletions(-)'),
	).toStrictEqual({filesChanged: 3, insertions: 120, deletions: 45});
	expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toStrictEqual({
		filesChanged: 1,
		insertions: 0,
		deletions: 1,
	});
	expect(parseShortstat('')).toStrictEqual({
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
	});
});

test('text output puts one space per line with its flags', () => {
	const text = formatSpaces({
		totalSpaces: 1,
		timestamp: 0,
		spaces: [
			{
				name: 'STA-1',
				status: 'waiting_for_input',
				minutesAgo: 12,
				tmuxSession: 'claude-r-STA-1',
				title: 'Fix auth',
				prUrl: null,
				git: {
					base: 'main',
					ahead: 3,
					filesChanged: 1,
					insertions: 1,
					deletions: 0,
					untracked: 2,
				},
				pipeline: 'failing',
				unresolvedCommentCount: 2,
			},
		],
	});
	expect(text).toBe(
		'STA-1  waiting_for_input  12m ago  Fix auth  +3 commits  +2 new files  [pipeline red]  [2 unresolved]',
	);
});

test('an agent still reporting under the bare status name is read until it reports under the qualified one', async () => {
	const home = tempHome();
	openSpaces(home, ['STA-1']);
	await writeStatus(home, 'STA-1', {
		status: 'processing',
		lastUpdate: Date.now(),
	});
	const before = await gather(home);
	expect(before[0]?.status).toBe('processing');
	await writeStatus(home, statusKey('STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	expect(after[0]?.status).toBe('ended');
});

async function recordIdentity(home: string, key: string) {
	const worktree = path.join(home, '.worktrees', REPO, key);
	const identity = newSpaceIdentity({
		repo: REPO,
		key,
		worktreePath: worktree,
		socket: 'pappardelle_inner',
	});
	await stores(home).spaceIdentities.record(identity);
	return {identity, worktree};
}

function writeStaleClaudeLog(home: string, worktree: string): void {
	writeJson(
		path.join(
			claudeProjectDir(worktree, path.join(home, '.claude', 'projects')),
			'old.jsonl',
		),
		'{}',
	);
}

async function setupOscSpaces(
	home: string,
	specs: Array<{
		key: string;
		info: ProgramStatusSnapshot['info'];
		updatedAt: number;
		authoritative?: boolean;
		exited?: boolean;
		dead?: boolean;
	}>,
): Promise<Pick<SpacesDeps, 'listStatusPanes' | 'programStatus'>> {
	openSpaces(
		home,
		specs.map(spec => spec.key),
	);
	const panes = new Map<string, StatusPane>();
	const snapshots = new Map<string, ProgramStatusSnapshot>();
	for (const [index, spec] of specs.entries()) {
		const {identity} = await recordIdentity(home, spec.key);
		const pid = String(10 + index);
		const pane = parseStatusPane(
			`%${pid}\t${pid}\t${spec.dead ? '1' : '0'}\t1\t${pid}.m`,
			'pappardelle_inner',
		)!;
		panes.set(identity.tmux.agentSession, pane);
		snapshots.set(spec.key, {
			version: 1,
			repo: REPO,
			key: spec.key,
			pane,
			authoritative: spec.authoritative ?? true,
			exited: spec.exited ?? false,
			updatedAt: spec.updatedAt,
			records: [],
			info: spec.info,
		});
	}

	return {
		listStatusPanes: async () =>
			new Map(
				[...panes].map(([session, pane]) => [session, {pinned: pane.id, pane}]),
			),
		programStatus: {
			async read(key, pane) {
				const snap = snapshots.get(key);
				return snap && snap.pane.generation === pane.generation ? snap : null;
			},
		},
	};
}

test('OSC program status reports Claude-vocabulary status and minutesAgo for agy and Codex spaces without Claude hooks', async () => {
	const home = tempHome();
	const now = 1_700_000_600_000;
	const osc = await setupOscSpaces(home, [
		{
			key: 'AGY-IDLE',
			info: {status: 'idle', app: 'antigravity'},
			updatedAt: now - 2 * 60_000,
		},
		{
			key: 'AGY-DONE',
			info: {status: 'done', app: 'antigravity'},
			updatedAt: now - 5 * 60_000,
		},
		{
			key: 'CODEX-WORK',
			info: {status: 'working', app: 'codex'},
			updatedAt: now - 0.5 * 60_000,
		},
		{
			key: 'CODEX-TOOL',
			info: {status: 'working', tool: 'Bash', app: 'codex'},
			updatedAt: now - 0.2 * 60_000,
		},
		{
			key: 'AGY-PERM',
			info: {status: 'blocked', kind: 'permission', app: 'antigravity'},
			updatedAt: now - 60_000,
		},
		{
			key: 'AGY-Q',
			info: {status: 'blocked', kind: 'question', app: 'antigravity'},
			updatedAt: now - 3 * 60_000,
		},
	]);

	const spaces = await gather(home, {now, ...osc});
	const byName = new Map(spaces.map(s => [s.name, s]));
	expect(byName.get('AGY-IDLE')).toMatchObject({
		status: 'waiting_for_input',
		minutesAgo: 2,
	});
	expect(byName.get('AGY-DONE')).toMatchObject({
		status: 'waiting_for_input',
		minutesAgo: 5,
	});
	expect(byName.get('CODEX-WORK')).toMatchObject({
		status: 'processing',
		minutesAgo: 0.5,
	});
	expect(byName.get('CODEX-TOOL')).toMatchObject({
		status: 'running_tool',
		currentTool: 'Bash',
		minutesAgo: 0.2,
	});
	expect(byName.get('AGY-PERM')).toMatchObject({
		status: 'waiting_for_approval',
		minutesAgo: 1,
	});
	expect(byName.get('AGY-Q')).toMatchObject({
		status: 'waiting_for_approval',
		minutesAgo: 3,
	});
	expect(spaces.map(s => s.name)).toStrictEqual([
		'CODEX-TOOL',
		'CODEX-WORK',
		'AGY-PERM',
		'AGY-IDLE',
		'AGY-Q',
		'AGY-DONE',
	]);
});

test('non-authoritative OSC snapshots fall back to Claude hook or no_status', async () => {
	const home = tempHome();
	const now = 1_700_000_000_000;
	const osc = await setupOscSpaces(home, [
		{
			key: 'STA-CLAUDE',
			info: {status: 'unknown'},
			updatedAt: now,
			authoritative: false,
		},
		{
			key: 'STA-NEW',
			info: {status: 'unknown'},
			updatedAt: now,
			authoritative: false,
		},
	]);
	await writeStatus(home, statusKey('STA-CLAUDE'), {
		status: 'running_tool',
		currentTool: 'Edit',
		lastUpdate: now - 60_000,
	});

	const spaces = await gather(home, {now, ...osc});
	const byName = new Map(spaces.map(s => [s.name, s]));
	expect(byName.get('STA-CLAUDE')).toMatchObject({
		status: 'running_tool',
		currentTool: 'Edit',
	});
	expect(byName.get('STA-NEW')?.status).toBe('no_status');
});

test('agy and Codex spaces ignore leftover Claude hook status and Claude session files', async () => {
	const home = tempHome();
	const now = 1_700_000_000_000;
	const daos = stores(home);
	openSpaces(home, ['AGY-SWITCHED', 'CODEX-SWITCHED']);
	for (const [key, profile] of [
		['AGY-SWITCHED', 'agy'],
		['CODEX-SWITCHED', 'codex'],
	] as const) {
		const {worktree} = await recordIdentity(home, key);
		await writeStatus(home, statusKey(key), {
			status: 'running_tool',
			currentTool: 'Bash',
			sessionId: `stale-claude-${key}`,
			lastUpdate: now - 30_000,
		});
		writeJson(path.join(home, '.claude', 'sessions', `${key}.json`), {
			pid: 99_999,
			cwd: worktree,
		});
		writeStaleClaudeLog(home, worktree);
		await daos.spaceState.write(key, {
			agentProfile: {name: profile, isClaude: false},
		});
	}

	const spaces = await gather(home, {now});
	for (const space of spaces) {
		expect(space.status).toBe('no_status');
		expect(space.currentTool).toBeUndefined();
		expect(space.lastUpdate).toBeUndefined();
		expect(space.sessionId).toBeUndefined();
		expect(space.pid).toBeUndefined();
		expect(space.worktreePath).toBeUndefined();
		expect(space.conversationLog).toBeUndefined();
	}
});

test('agy spaces expose their transcript as conversationLog and never fall back to stale Claude logs', async () => {
	const home = tempHome();
	const now = 1_700_000_000_000;
	const daos = stores(home);
	openSpaces(home, ['AGY-WITH-LOG', 'AGY-NO-LOG']);
	for (const key of ['AGY-WITH-LOG', 'AGY-NO-LOG']) {
		const {worktree} = await recordIdentity(home, key);
		writeStaleClaudeLog(home, worktree);
	}

	await daos.spaceState.write('AGY-WITH-LOG', {
		agentProfile: {name: 'argon', isClaude: false},
	});
	await daos.spaceState.write('AGY-NO-LOG', {
		agentProfile: {name: 'agy', isClaude: false},
	});
	writeJson(daos.agentSessions.file('AGY-WITH-LOG'), {
		argon: {session_id: 'conv-123', pid: 42, started: null},
	});
	const agyLog = path.join(
		home,
		'.gemini',
		'antigravity-cli',
		'brain',
		'conv-123',
		'.system_generated',
		'logs',
		'transcript.jsonl',
	);
	fs.mkdirSync(path.dirname(agyLog), {recursive: true});
	fs.writeFileSync(agyLog, '{"type":"USER_INPUT","content":"hi"}\n');
	const config: PappardelleConfig = {
		version: 1,
		team_prefix: 'STA',
		agent_profiles: {argon: {command: 'agy'}},
		profiles: {dev: {display_name: 'Dev'}},
	};

	const spaces = await gather(home, {now, config});
	const byName = new Map(spaces.map(s => [s.name, s]));
	expect(byName.get('AGY-WITH-LOG')?.conversationLog).toBe(agyLog);
	expect(typeof byName.get('AGY-WITH-LOG')?.logMinutesAgo).toBe('number');
	expect(byName.get('AGY-NO-LOG')?.conversationLog).toBeUndefined();
});

test('exited OSC snapshots and dead panes report ended, and Claude ended/compacting hooks win over OSC', async () => {
	const home = tempHome();
	const now = 1_700_000_000_000;
	const osc = await setupOscSpaces(home, [
		{
			key: 'OSC-EXITED',
			info: {status: 'idle', app: 'antigravity'},
			updatedAt: now - 10_000,
			exited: true,
		},
		{
			key: 'PANE-DEAD',
			info: {status: 'idle', app: 'antigravity'},
			updatedAt: now - 10_000,
			dead: true,
		},
		{
			key: 'CLAUDE-ENDED',
			info: {status: 'idle', app: 'antigravity'},
			updatedAt: now - 10_000,
		},
		{
			key: 'CLAUDE-COMPACT',
			info: {status: 'working', app: 'claude-code'},
			updatedAt: now - 10_000,
		},
	]);
	await writeStatus(home, statusKey('CLAUDE-ENDED'), {
		status: 'ended',
		lastUpdate: now - 5000,
	});
	await writeStatus(home, statusKey('CLAUDE-COMPACT'), {
		status: 'compacting',
		lastUpdate: now - 5000,
	});

	const spaces = await gather(home, {now, ...osc});
	const byName = new Map(spaces.map(s => [s.name, s]));
	expect(byName.get('OSC-EXITED')?.status).toBe('ended');
	expect(byName.get('PANE-DEAD')?.status).toBe('ended');
	expect(byName.get('CLAUDE-ENDED')?.status).toBe('ended');
	expect(byName.get('CLAUDE-COMPACT')?.status).toBe('compacting');
});
