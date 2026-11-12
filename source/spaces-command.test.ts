import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	formatSpaces,
	gatherSpaces,
	parseShortstat,
	worktreeGitSummary,
	type SpaceEntry,
	type SpacesDeps,
} from './spaces-command.ts';
import {createStateDaos} from './state-daos.ts';
import {closeStateDb, stateDbPath} from './state-db.ts';
import {sqliteRun} from '../test/helpers/state.ts';

const REPO = 'test-repo';

function tempHome(t: {teardown: (fn: () => void) => void}): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'papp-spaces-'));
	t.teardown(() => {
		closeStateDb(stateDbPath(path.join(home, '.pappardelle')));
		fs.rmSync(home, {recursive: true, force: true});
	});
	return home;
}

/** The stores a process run with this home directory would read. */
const stores = (home: string) =>
	createStateDaos({
		repo: REPO,
		stateDir: path.join(home, '.pappardelle'),
		sqlite: sqliteRun,
	});

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(
		file,
		typeof data === 'string' ? data : JSON.stringify(data),
	);
}

const repoState = (home: string, ...rest: string[]) =>
	path.join(home, '.pappardelle', 'repos', REPO, ...rest);

const statusFile = (home: string, key: string, repo = REPO) =>
	path.join(home, '.pappardelle', 'claude-status', `${repo}-${key}.json`);

function openSpaces(home: string, keys: string[]): void {
	writeJson(repoState(home, 'open-spaces.json'), keys);
}

async function gather(
	home: string,
	overrides: Partial<SpacesDeps> = {},
): Promise<SpaceEntry[]> {
	const report = await gatherSpaces({
		repoName: REPO,
		registry: stores(home).registry,
		home,
		fetchTitles: async () => new Map(),
		gitSummary: async () => null,
		...overrides,
	});
	if ('error' in report) throw new Error(report.error);
	return report.spaces;
}

test('a repo with no open-spaces file reports the error', async t => {
	const home = tempHome(t);
	t.deepEqual(
		await gatherSpaces({
			repoName: REPO,
			registry: stores(home).registry,
			home,
			fetchTitles: async () => new Map(),
			gitSummary: async () => null,
		}),
		{error: 'No open spaces file found', spaces: []},
	);
});

test('status comes from the claude-status file, raw', async t => {
	const home = tempHome(t);
	const now = Date.now();
	openSpaces(home, ['STA-100', 'STA-200', 'STA-700']);
	writeJson(statusFile(home, 'STA-100'), {
		status: 'processing',
		currentTool: 'Bash',
		// Older than the TUI's active-status timeout; the board still sees it.
		lastUpdate: now - 3 * 60 * 60_000,
		sessionId: 'sess-abc',
	});
	writeJson(statusFile(home, 'STA-700'), 'not json{{{');
	const spaces = await gather(home, {now});
	const byName = new Map(spaces.map(space => [space.name, space]));
	t.like(byName.get('STA-100'), {
		status: 'processing',
		currentTool: 'Bash',
		sessionId: 'sess-abc',
		minutesAgo: 180,
	});
	t.is(byName.get('STA-200')?.status, 'no_status');
	t.is(byName.get('STA-700')?.status, 'unknown');
});

test('another repo with a space of the same key does not supply its status', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	writeJson(statusFile(home, 'STA-1', 'other-repo'), {
		status: 'waiting_for_approval',
		lastUpdate: Date.now(),
	});
	const before = await gather(home);
	t.is(before[0]?.status, 'no_status');
	writeJson(statusFile(home, 'STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	t.is(after[0]?.status, 'ended');
});

test('metadata, rail state and the newest PR link are included', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-350']);
	writeJson(repoState(home, 'issue-meta', 'STA-350.json'), {title: 'Fix it'});
	writeJson(repoState(home, 'space-state', 'STA-350.json'), {
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		updatedAt: '2026-04-21T05:00:00.000Z',
		prLinks: [
			{url: 'https://example.com/pr/1'},
			{url: 'https://example.com/pr/2'},
		],
	});
	const [space] = await gather(home);
	t.like(space, {
		meta: {title: 'Fix it'},
		pipeline: 'failing',
		unresolvedCommentCount: 4,
		prNumber: 777,
		recap: {customTitle: 'refactor auth'},
		spaceStateUpdatedAt: '2026-04-21T05:00:00.000Z',
		prUrl: 'https://example.com/pr/2',
	});
});

test('rail fields are absent without a readable space-state file', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-360', 'STA-370']);
	writeJson(repoState(home, 'space-state', 'STA-370.json'), 'not json{{{');
	for (const space of await gather(home)) {
		t.false('pipeline' in space);
		t.false('recap' in space);
		t.is(space.prUrl, null);
	}
});

test('sessions match on the full worktree prefix and the newest wins', async t => {
	const home = tempHome(t);
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
	t.is(byName.get('STA-400')?.pid, 22_222);
	t.is(byName.get('STA-500')?.pid, undefined);
});

test('the newest top-level jsonl is the conversation log', async t => {
	const home = tempHome(t);
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
	t.is(space!.conversationLog, path.join(dir, 'new.jsonl'));
	t.is(typeof space!.logMinutesAgo, 'number');
});

test('spaces sort by last update and carry tmux session names', async t => {
	const home = tempHome(t);
	const now = Date.now();
	openSpaces(home, ['STA-OLD', 'STA-NEW', 'a.b_c']);
	const status = (key: string, ago: number) =>
		writeJson(statusFile(home, key), {
			status: 'ended',
			lastUpdate: now - ago,
		});
	status('STA-OLD', 60_000);
	status('STA-NEW', 0);
	const spaces = await gather(home, {now});
	t.deepEqual(
		spaces.map(s => s.name),
		['STA-NEW', 'STA-OLD', 'a.b_c'],
	);
	t.is(spaces[2]!.tmuxSession, `agent-${REPO}-a_b__c`);
});

test('titles come from the tracker, and null when it fails or is slow', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	const [found] = await gather(home, {
		fetchTitles: async () => new Map([['STA-1', 'Fix auth']]),
	});
	t.is(found!.title, 'Fix auth');
	const [failed] = await gather(home, {
		async fetchTitles() {
			throw new Error('offline');
		},
	});
	t.is(failed!.title, null);
	const [slow] = await gather(home, {
		titleTimeoutMs: 20,
		fetchTitles: async () =>
			new Promise(resolve => {
				setTimeout(() => {
					resolve(new Map([['STA-1', 'late']]));
				}, 500);
			}),
	});
	t.is(slow!.title, null);
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

test('the git summary counts commits ahead of main and the diff since the branch point', async t => {
	const home = tempHome(t);
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
	t.deepEqual(await worktreeGitSummary(repo), {
		base: 'main',
		ahead: 2,
		filesChanged: 2,
		insertions: 2,
		deletions: 0,
		untracked: 1,
	});
});

test('parseShortstat reads each count, singular or plural, and missing ones as 0', t => {
	t.deepEqual(
		parseShortstat(' 3 files changed, 120 insertions(+), 45 deletions(-)'),
		{filesChanged: 3, insertions: 120, deletions: 45},
	);
	t.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), {
		filesChanged: 1,
		insertions: 0,
		deletions: 1,
	});
	t.deepEqual(parseShortstat(''), {
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
	});
});

test('text output puts one space per line with its flags', t => {
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
	t.is(
		text,
		'STA-1  waiting_for_input  12m ago  Fix auth  +3 commits  +2 new files  [pipeline red]  [2 unresolved]',
	);
});

test('an agent still writing the bare status name is read until the qualified file appears', async t => {
	const home = tempHome(t);
	openSpaces(home, ['STA-1']);
	const bare = path.join(home, '.pappardelle', 'claude-status', 'STA-1.json');
	writeJson(bare, {status: 'working', lastUpdate: Date.now()});
	const before = await gather(home);
	t.is(before[0]?.status, 'working');
	writeJson(statusFile(home, 'STA-1'), {
		status: 'ended',
		lastUpdate: Date.now(),
	});
	const after = await gather(home);
	t.is(after[0]?.status, 'ended');
});
