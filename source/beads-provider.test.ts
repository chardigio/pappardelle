import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {
	BeadsProvider,
	MAX_RETRIES,
	beadsIssuePrefix,
	buildIssuePopupArgv,
	beadsStateName,
	beadsStateType,
	mapBeadsIssue,
	normalizeBeadsStatus,
	unreachableReadyStatuses,
	type CliExecutor,
	type SleepFn,
} from './providers/beads-provider.ts';
import {unwrapBeadsJson} from './providers/beads-json.ts';
import {StateColorCache} from './providers/state-color-cache.ts';
import {clearRecentErrors, getRecentErrors} from './logger.ts';

function makeEnoentError(): Error & {code: string} {
	const err = new Error('spawn bd ENOENT') as Error & {code: string};
	err.code = 'ENOENT';
	return err;
}

// No-op sleep so tests don't wait
const noopSleep: SleepFn = async () => {};

/** A cache that keeps colors for the test only, never the real ~/.pappardelle. */
function tempCache(): StateColorCache {
	return new StateColorCache();
}

const REPO_ROOT = '/tmp/pappardelle-beads-test-repo';
const resolveCwd = () => REPO_ROOT;

/** Build a provider whose CLI is a canned stdout string per invocation. */
function providerReturning(...outputs: Array<string | Error>): {
	provider: BeadsProvider;
	calls: string[][];
} {
	const calls: string[][] = [];
	let index = 0;
	const exec: CliExecutor = async (_cmd, args) => {
		calls.push(args);
		const next = outputs[Math.min(index, outputs.length - 1)];
		index++;
		if (next instanceof Error) throw next;
		return next ?? '[]';
	};
	return {
		provider: new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd),
		calls,
	};
}

const OPEN_ISSUE = {
	id: 'sddamico-hic',
	title: "better-sqlite3 can't build",
	description: 'CLT libc++ headers missing',
	status: 'open',
	priority: 1,
	issue_type: 'bug',
	owner: 'stephen@example.com',
	created_at: '2026-07-30T01:35:25Z',
	updated_at: '2026-07-30T01:35:25Z',
	dependency_count: 0,
	comment_count: 0,
};

// unwrapBeadsJson — payload shapes bd can emit

test('unwrapBeadsJson reads a bare array (legacy --json)', () => {
	const rows = unwrapBeadsJson(JSON.stringify([OPEN_ISSUE]));
	expect(rows.length).toBe(1);
	expect(rows[0]!['id']).toBe('sddamico-hic');
});

test('unwrapBeadsJson unwraps the schema envelope', () => {
	// BD_JSON_ENVELOPE=1 today, the default from beads 2.0 on.
	const rows = unwrapBeadsJson(
		JSON.stringify({schema_version: 1, data: [OPEN_ISSUE]}),
	);
	expect(rows.length).toBe(1);
	expect(rows[0]!['id']).toBe('sddamico-hic');
});

test('unwrapBeadsJson wraps a lone object into a list', () => {
	const rows = unwrapBeadsJson(JSON.stringify(OPEN_ISSUE));
	expect(rows.length).toBe(1);
	expect(rows[0]!['title']).toBe("better-sqlite3 can't build");
});

test('unwrapBeadsJson unwraps an enveloped lone object', () => {
	const rows = unwrapBeadsJson(
		JSON.stringify({schema_version: 1, data: OPEN_ISSUE}),
	);
	expect(rows.length).toBe(1);
	expect(rows[0]!['id']).toBe('sddamico-hic');
});

test('unwrapBeadsJson returns nothing for an empty or scalar payload', () => {
	expect(unwrapBeadsJson('[]')).toStrictEqual([]);
	expect(unwrapBeadsJson('null')).toStrictEqual([]);
	expect(unwrapBeadsJson('"nope"')).toStrictEqual([]);
});

test('unwrapBeadsJson drops non-object rows rather than mapping them', () => {
	const rows = unwrapBeadsJson(JSON.stringify([OPEN_ISSUE, null, 3]));
	expect(rows.length).toBe(1);
});

// beadsIssuePrefix — the stand-in for Linear/Jira's project field

test('beadsIssuePrefix splits on the last hyphen', () => {
	expect(beadsIssuePrefix('bd-a1b2')).toBe('bd');
	expect(beadsIssuePrefix('sddamico-hic')).toBe('sddamico');
});

test('beadsIssuePrefix keeps hyphens inside the prefix', () => {
	// The prefix defaults to the repo directory name, which routinely has them.
	expect(beadsIssuePrefix('seatgeek-ticket-management-cli-bqm')).toBe(
		'seatgeek-ticket-management-cli',
	);
});

test('beadsIssuePrefix ignores hierarchical child suffixes', () => {
	expect(beadsIssuePrefix('bd-a3f8e9.1')).toBe('bd');
	expect(beadsIssuePrefix('bd-a3f8e9.1.2')).toBe('bd');
});

test('beadsIssuePrefix returns empty for an ID with no hyphen', () => {
	expect(beadsIssuePrefix('nohyphen')).toBe('');
});

// Status mapping

test('beadsStateType reports closed as completed for auto-remove', () => {
	// auto-remove.ts keys off the Linear-flavored 'completed'/'canceled'.
	expect(beadsStateType('closed')).toBe('completed');
});

test('beadsStateType passes every other status through untouched', () => {
	// Including user-defined ones, which beads allows via its status.custom key.
	for (const status of ['open', 'in_progress', 'blocked', 'needs_review']) {
		expect(beadsStateType(status)).toBe(status);
	}
});

test('beadsStateName title-cases the snake_case status', () => {
	expect(beadsStateName('in_progress')).toBe('In Progress');
	expect(beadsStateName('open')).toBe('Open');
});

// mapBeadsIssue — pure parsing logic

test('mapBeadsIssue maps a standard bd row', () => {
	const issue = mapBeadsIssue(OPEN_ISSUE);
	expect(issue.identifier).toBe('sddamico-hic');
	expect(issue.title).toBe("better-sqlite3 can't build");
	expect(issue.state.name).toBe('Open');
	expect(issue.state.type).toBe('open');
	expect(issue.state.color).toBe('gray');
});

test('mapBeadsIssue carries created_at through as createdAt', () => {
	const issue = mapBeadsIssue({
		id: 'sddamico-hic',
		title: 'x',
		created_at: '2026-07-21T23:34:43Z',
	});
	expect(issue.createdAt).toBe('2026-07-21T23:34:43Z');
	expect(mapBeadsIssue({id: 'sddamico-hic', title: 'x'}).createdAt).toBe(
		undefined,
	);
});

test('mapBeadsIssue never uppercases the identifier', () => {
	// A beads ID is case-sensitive; uppercasing yields one bd cannot resolve.
	expect(mapBeadsIssue({id: 'bd-a1b2', title: 'x'}).identifier).toBe('bd-a1b2');
});

test('mapBeadsIssue exposes the prefix as the project', () => {
	const issue = mapBeadsIssue({id: 'sddamico-hic', title: 'x', status: 'open'});
	expect(issue.project).toStrictEqual({name: 'sddamico', key: 'sddamico'});
});

test('mapBeadsIssue reports no project for a prefixless ID', () => {
	expect(mapBeadsIssue({id: 'nohyphen', title: 'x'}).project).toBe(null);
});

test('mapBeadsIssue maps a closed issue to the terminal state type', () => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, status: 'closed'});
	expect(issue.state.type).toBe('completed');
	expect(issue.state.name).toBe('Closed');
	expect(issue.state.color).toBe('green');
});

test('mapBeadsIssue gives an unknown status the fallback color', () => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, status: 'needs_review'});
	expect(issue.state.name).toBe('Needs Review');
	expect(issue.state.color).toBe('gray');
});

test('mapBeadsIssue keeps string labels and drops the rest', () => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, labels: ['bug', 7, 'infra']});
	expect(issue.labels).toStrictEqual(['bug', 'infra']);
});

test('mapBeadsIssue omits labels when bd sent none', () => {
	expect(mapBeadsIssue(OPEN_ISSUE).labels).toBe(undefined);
});

test('mapBeadsIssue tolerates a row missing title and status', () => {
	const issue = mapBeadsIssue({id: 'bd-a1b2'});
	expect(issue.title).toBe('');
	expect(issue.state.type).toBe('open');
});

// getIssue

test('getIssue fetches and maps an issue', async () => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issue = await provider.getIssue('sddamico-hic');
	expect(issue?.title).toBe("better-sqlite3 can't build");
	expect(calls[0]).toStrictEqual(['show', '--id=sddamico-hic', '--json']);
});

test('getIssue picks the row whose id was asked for', async () => {
	const other = {...OPEN_ISSUE, id: 'sddamico-zzz', title: 'Other'};
	const {provider} = providerReturning(
		JSON.stringify([other, {...OPEN_ISSUE, title: 'Wanted'}]),
	);
	const issue = await provider.getIssue('sddamico-hic');
	expect(issue?.title).toBe('Wanted');
});

test('getIssue returns null when bd reports no rows', async () => {
	const {provider} = providerReturning('[]');
	expect(await provider.getIssue('sddamico-nope')).toBe(null);
});

test('getIssue serves a second call from cache', async () => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	await provider.getIssue('sddamico-hic');
	await provider.getIssue('sddamico-hic');
	expect(calls.length).toBe(1);
});

test('getIssue retries a failing bd call', async () => {
	const {provider, calls} = providerReturning(
		new Error('database locked'),
		JSON.stringify([OPEN_ISSUE]),
	);
	const issue = await provider.getIssue('sddamico-hic');
	expect(issue?.title).toBe("better-sqlite3 can't build");
	expect(calls.length).toBe(2);
});

test('getIssue gives up after MAX_RETRIES', async () => {
	const {provider, calls} = providerReturning(new Error('nope'));
	expect(await provider.getIssue('sddamico-hic')).toBe(null);
	expect(calls.length).toBe(MAX_RETRIES);
});

test('a missing bd binary disables the provider instead of retrying', async () => {
	const {provider, calls} = providerReturning(makeEnoentError());
	expect(await provider.getIssue('sddamico-hic')).toBe(null);
	expect(await provider.getIssue('sddamico-other')).toBe(null);
	// One attempt total: ENOENT is sticky, and no retry can fix it.
	expect(calls.length).toBe(1);
});

// getIssues

test('getIssues fetches a batch in one bd list call', async () => {
	const second = {...OPEN_ISSUE, id: 'sddamico-ck8', title: 'Second'};
	const {provider, calls} = providerReturning(
		JSON.stringify([OPEN_ISSUE, second]),
	);
	const map = await provider.getIssues(['sddamico-hic', 'sddamico-ck8']);
	expect(map.get('sddamico-hic')?.title).toBe("better-sqlite3 can't build");
	expect(map.get('sddamico-ck8')?.title).toBe('Second');
	expect(calls[0]).toStrictEqual([
		'list',
		'--id=sddamico-hic,sddamico-ck8',
		'--json',
		'-n',
		'0',
	]);
});

test('getIssues resolves keys the batch missed individually', async () => {
	const {provider, calls} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		JSON.stringify([{...OPEN_ISSUE, id: 'sddamico-ck8', title: 'Second'}]),
	);
	const map = await provider.getIssues(['sddamico-hic', 'sddamico-ck8']);
	expect(map.get('sddamico-ck8')?.title).toBe('Second');
	expect(calls[1]?.[0]).toBe('show');
});

test('getIssues falls back to individual fetches when the batch errors', async () => {
	let call = 0;
	const exec: CliExecutor = async (_cmd, args) => {
		call++;
		if (args[0] === 'list') throw new Error('bad flag');
		return JSON.stringify([OPEN_ISSUE]);
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	const map = await provider.getIssues(['sddamico-hic']);
	expect(map.get('sddamico-hic')?.title).toBe("better-sqlite3 can't build");
	expect(call > 1).toBe(true);
});

test('getIssues short-circuits on an empty key list', async () => {
	const {provider, calls} = providerReturning('[]');
	const map = await provider.getIssues([]);
	expect(map.size).toBe(0);
	expect(calls.length).toBe(0);
});

// searchAssignedIssues — the watchlist, sourced from `bd ready`

test('searchAssignedIssues reads bd ready', async () => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issues = await provider.searchAssignedIssues(undefined, []);
	expect(issues.length).toBe(1);
	expect(calls[0]).toStrictEqual([
		'ready',
		'--json',
		'-n',
		'0',
		'--exclude-type',
		'epic,convoy,molecule,event,merge-request',
	]);
});

test('searchAssignedIssues narrows bd ready by configured status', async () => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, ['open']);
	expect(issues.map(i => i.identifier)).toStrictEqual(['sddamico-hic']);
});

test('searchAssignedIssues matches a status by display name too', async () => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, [
		'In Progress',
	]);
	expect(issues.map(i => i.identifier)).toStrictEqual(['sddamico-ck8']);
});

test('searchAssignedIssues takes every ready issue when no status is set', async () => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, []);
	expect(issues.length).toBe(2);
});

test('searchAssignedIssues passes an explicit assignee through', async () => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues('alice@example.com', []);
	expect(calls[0]).toStrictEqual([
		'ready',
		'--json',
		'-n',
		'0',
		'--exclude-type',
		'epic,convoy,molecule,event,merge-request',
		'--assignee',
		'alice@example.com',
	]);
});

// A watchlist match spawns a worktree with no one in the loop, so the container
// and bookkeeping types have to be filtered at the query — bd accepts an
// unknown --exclude-type silently, so this is the only place a typo shows up.
test('the watchlist does not offer a container or a bookkeeping row', async () => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues(undefined, []);
	const argv = calls[0]!;
	const excluded = argv[argv.indexOf('--exclude-type') + 1]!.split(',');
	expect(excluded).toStrictEqual([
		'epic',
		'convoy',
		'molecule',
		'event',
		'merge-request',
	]);
});

// A person is choosing in the picker, and opening a worktree against a
// container to work through its children is a legitimate thing to want.
test('the picker still offers a container row', async () => {
	const {provider, calls} = providerReturning('[]');
	await provider.listReadyIssues();
	expect(calls[0]!.includes('--exclude-type')).toBe(false);
});

// Writing an ADR produces a real diff, so a decision is work like any other.
test('a decision is still offered to the watchlist', async () => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues(undefined, []);
	const argv = calls[0]!;
	expect(
		argv[argv.indexOf('--exclude-type') + 1]!.split(',').includes('decision'),
	).toBe(false);
});

test('searchAssignedIssues resolves "me" from the environment', async () => {
	const previous = process.env['BEADS_ACTOR'];
	process.env['BEADS_ACTOR'] = 'charlie';
	try {
		const {provider, calls} = providerReturning('[]');
		await provider.searchAssignedIssues('me', []);
		expect(calls[0]!.includes('charlie')).toBe(true);
	} finally {
		if (previous === undefined) {
			delete process.env['BEADS_ACTOR'];
		} else {
			process.env['BEADS_ACTOR'] = previous;
		}
	}
});

/** Provider whose executor answers `git` and `bd` separately. */
function providerWithGit(gitName: string | Error): {
	provider: BeadsProvider;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: CliExecutor = async (cmd, args) => {
		if (cmd === 'git') {
			if (gitName instanceof Error) throw gitName;
			return `${gitName}\n`;
		}

		calls.push(args);
		return '[]';
	};
	return {
		provider: new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd),
		calls,
	};
}

// `bd` stamps $BEADS_ACTOR, then git user.name, then $USER onto an issue it
// claims. Resolving "me" straight to $USER matched nothing on the common setup
// where a full name is configured but the OS login is a handle.
test('searchAssignedIssues resolves "me" through git user.name', async () => {
	const previousActor = process.env['BEADS_ACTOR'];
	delete process.env['BEADS_ACTOR'];
	try {
		const {provider, calls} = providerWithGit('Ada Lovelace');
		await provider.searchAssignedIssues('me', []);
		expect(calls[0]!.includes('Ada Lovelace')).toBe(true);
	} finally {
		if (previousActor !== undefined) {
			process.env['BEADS_ACTOR'] = previousActor;
		}
	}
});

test('searchAssignedIssues falls back to $USER with no git identity', async () => {
	const previousActor = process.env['BEADS_ACTOR'];
	const previousUser = process.env['USER'];
	delete process.env['BEADS_ACTOR'];
	process.env['USER'] = 'ada';
	try {
		const {provider, calls} = providerWithGit(new Error('no user.name set'));
		await provider.searchAssignedIssues('me', []);
		expect(calls[0]!.includes('ada')).toBe(true);
	} finally {
		if (previousActor !== undefined) {
			process.env['BEADS_ACTOR'] = previousActor;
		}

		if (previousUser === undefined) {
			delete process.env['USER'];
		} else {
			process.env['USER'] = previousUser;
		}
	}
});

test('a status bd ready cannot return yields an empty watchlist', async () => {
	// `bd ready` excludes in_progress/blocked/deferred/hooked by construction,
	// so it only ever hands back open issues. A watchlist config carried over
	// from Linear ("In Progress") therefore matches nothing — the provider warns
	// (see unreachableReadyStatuses) rather than failing.
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	expect(
		await provider.searchAssignedIssues(undefined, ['in_progress']),
	).toStrictEqual([]);
});

test('unreachableReadyStatuses flags statuses bd ready never returns', () => {
	expect(unreachableReadyStatuses(['open'])).toStrictEqual([]);
	expect(unreachableReadyStatuses(['in_progress'])).toStrictEqual([
		'in_progress',
	]);
	// Display-name spelling, as a Linear/Jira watchlist would write it.
	expect(unreachableReadyStatuses(['In Progress'])).toStrictEqual([
		'In Progress',
	]);
	expect(unreachableReadyStatuses(['Open', 'blocked'])).toStrictEqual([
		'blocked',
	]);
	expect(unreachableReadyStatuses([])).toStrictEqual([]);
});

test('searchAssignedIssues returns nothing when bd is missing', async () => {
	const {provider} = providerReturning(makeEnoentError());
	expect(await provider.searchAssignedIssues(undefined, [])).toStrictEqual([]);
});

// listReadyIssues

test('listReadyIssues reads bd ready with no assignee filter', async () => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issues = await provider.listReadyIssues();
	expect(issues.map(i => i.identifier)).toStrictEqual(['sddamico-hic']);
	expect(calls[0]).toStrictEqual(['ready', '--json', '-n', '0']);
});

// Unlike the watchlist, the picker keeps whatever bd ready hands back: beads
// issues are usually unassigned until claimed, so any narrowing would empty it.
test('listReadyIssues keeps every row bd ready returns', async () => {
	const other = {...OPEN_ISSUE, id: 'sddamico-ck8', assignee: 'someone-else'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, other]));
	const issues = await provider.listReadyIssues();
	expect(issues.map(i => i.identifier)).toStrictEqual([
		'sddamico-hic',
		'sddamico-ck8',
	]);
});

test('listReadyIssues returns nothing when bd is missing', async () => {
	const {provider} = providerReturning(makeEnoentError());
	expect(await provider.listReadyIssues()).toStrictEqual([]);
});

test('listReadyIssues returns nothing when bd fails', async () => {
	const {provider} = providerReturning(new Error('bd exploded'));
	expect(await provider.listReadyIssues()).toStrictEqual([]);
});

test('listReadyIssues skips malformed rows and keeps the valid ones', async () => {
	const {provider} = providerReturning(
		JSON.stringify([{nonsense: true}, OPEN_ISSUE]),
	);
	const issues = await provider.listReadyIssues();
	expect(issues.map(i => i.identifier)).toStrictEqual(['sddamico-hic']);
});

// closeIssue

test('closeIssue runs bd close', async () => {
	const {provider, calls} = providerReturning('');
	expect(await provider.closeIssue('sddamico-hic')).toBe(true);
	expect(calls[0]).toStrictEqual(['close', '--', 'sddamico-hic']);
});

// The escape is not decoration: `bd show -weird-xyz` dies with "unknown
// shorthand flag: 'e'". close/update/comments add have no --id of their own,
// so `--` is the only thing standing between a dash-led prefix and the parser.
test("the id is fenced off from bd's flag parser", async () => {
	const {provider, calls} = providerReturning('', '', '');
	await provider.closeIssue('-weird-xyz');
	await provider.claimIssue('-weird-xyz');
	for (const argv of calls) {
		expect(argv.at(-1)).toBe('-weird-xyz');
		expect(argv.at(-2)).toBe('--');
	}
});

test('closeIssue drops the cached copy so the next read comes from bd', async () => {
	const {provider} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		'',
		makeEnoentError(),
	);
	await provider.getIssue('sddamico-hic');
	await provider.closeIssue('sddamico-hic');

	// bd is gone by this point, so a surviving cache entry is the only way
	// getIssue could still answer.
	expect(await provider.getIssue('sddamico-hic')).toBe(null);
});

test('closeIssue reports failure when bd fails', async () => {
	const {provider} = providerReturning(new Error('bd exploded'));
	expect(await provider.closeIssue('sddamico-hic')).toBe(false);
});

test('closeIssue reports failure when bd is missing', async () => {
	const {provider} = providerReturning(makeEnoentError());
	expect(await provider.closeIssue('sddamico-hic')).toBe(false);
});

// claimIssue

test('claimIssue runs bd update --claim', async () => {
	const {provider, calls} = providerReturning('');
	expect(await provider.claimIssue('sddamico-hic')).toBe(true);
	expect(calls[0]).toStrictEqual(['update', '--claim', '--', 'sddamico-hic']);
});

test('claimIssue runs from the main repo root, not the caller cwd', async () => {
	// Regression: a claim that runs from a worktree lets bd auto-discover that
	// worktree's own .beads and write the transition to the wrong database, so
	// the issue never leaves the canonical ready pool.
	let seenCwd = '';
	const exec: CliExecutor = async (_cmd, _args, opts) => {
		seenCwd = opts.cwd;
		return '';
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	await provider.claimIssue('sddamico-hic');
	expect(seenCwd).toBe(REPO_ROOT);
});

test('claimIssue drops the cached copy so the next read sees in_progress', async () => {
	const {provider} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		'',
		makeEnoentError(),
	);
	await provider.getIssue('sddamico-hic');
	await provider.claimIssue('sddamico-hic');

	// bd is gone by this point, so a surviving cache entry is the only way
	// getIssue could still answer — and it would answer "open".
	expect(await provider.getIssue('sddamico-hic')).toBe(null);
});

test('claimIssue reports failure when bd fails', async () => {
	const {provider} = providerReturning(new Error('bd exploded'));
	expect(await provider.claimIssue('sddamico-hic')).toBe(false);
});

test('claimIssue reports failure when bd is missing', async () => {
	const {provider} = providerReturning(makeEnoentError());
	expect(await provider.claimIssue('sddamico-hic')).toBe(false);
});

// createComment

test('createComment hands bd a file holding the body', async () => {
	let bodyPath = '';
	let seen = '';
	const exec: CliExecutor = async (_cmd, args) => {
		bodyPath = args[args.indexOf('-f') + 1]!;
		seen = fs.readFileSync(bodyPath, 'utf-8');
		return '';
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	expect(await provider.createComment('bd-a1b2', '### Answered\n\nyes')).toBe(
		true,
	);
	expect(seen).toBe('### Answered\n\nyes');
	// The staging file is cleaned up regardless of outcome.
	expect(fs.existsSync(bodyPath)).toBe(false);
});

test('createComment retries then reports failure', async () => {
	const {provider, calls} = providerReturning(new Error('locked'));
	expect(await provider.createComment('bd-a1b2', 'body')).toBe(false);
	expect(calls.length).toBe(MAX_RETRIES);
});

test('createComment gives up immediately when bd is missing', async () => {
	const {provider, calls} = providerReturning(makeEnoentError());
	expect(await provider.createComment('bd-a1b2', 'body')).toBe(false);
	expect(calls.length).toBe(1);
});

// Misc surface

test('openIssue reports failure outside tmux', async () => {
	const {provider} = providerReturning('[]');
	expect(await provider.openIssue('bd-a1b2')).toBe(false);
});

test('openIssue popup is pinned to the main repo root', () => {
	// A popup launched from a worktree pane would otherwise read that worktree's
	// checked-out .beads/ copy instead of the database the rail is showing.
	const argv = buildIssuePopupArgv(REPO_ROOT, 'bd-a1b2');
	expect(argv[argv.indexOf('-C') + 1]).toBe(REPO_ROOT);
});

test('getWorkflowStateColor resolves a display name back to its color', async () => {
	const {provider} = providerReturning(
		JSON.stringify([{...OPEN_ISSUE, status: 'in_progress'}]),
	);
	await provider.getIssue('sddamico-hic');
	expect(provider.getWorkflowStateColor('In Progress')).toBe('blue');
});

test('getWorkflowStateColor answers for a state never fetched', () => {
	const {provider} = providerReturning('[]');
	expect(provider.getWorkflowStateColor('Blocked')).toBe('yellow');
	expect(provider.getWorkflowStateColor('Nonsense')).toBe(null);
});

test('clearCache forces the next getIssue back to bd', async () => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	await provider.getIssue('sddamico-hic');
	provider.clearCache();
	await provider.getIssue('sddamico-hic');
	expect(calls.length).toBe(2);
});

test('bd runs from the repo root with the JSON envelope requested', async () => {
	let options: {cwd: string; env: NodeJS.ProcessEnv} | undefined;
	const exec: CliExecutor = async (_cmd, _args, opts) => {
		options = opts;
		return '[]';
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	await provider.getIssue('sddamico-hic');
	// Every worktree must read the one canonical database at the repo root.
	expect(options?.cwd).toBe(REPO_ROOT);
	expect(options?.env['BD_JSON_ENVELOPE']).toBe('1');
});

// ---------------------------------------------------------------------------
// Cache keying

test('a row bd spells differently is cached under the key we asked for', async () => {
	// getIssue deliberately accepts rows[0] when no id matches the request, so
	// bd folding case (or resolving an alias) is a supported outcome. Caching
	// only bd's spelling left the requested key permanently absent: every read
	// re-forked bd, and getIssueCached — called on each render of the row —
	// answered null forever, so the row never stopped saying "Loading…".
	const {provider, calls} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		makeEnoentError(),
	);

	const fetched = await provider.getIssue('SDDAMICO-HIC');
	expect(fetched?.identifier).toBe('sddamico-hic');
	expect(provider.getIssueCached('SDDAMICO-HIC')?.identifier).toBe(
		'sddamico-hic',
	);
	expect(provider.getIssueCached('sddamico-hic')?.identifier).toBe(
		'sddamico-hic',
	);

	// bd is gone by now, so a second answer can only come from the cache.
	const again = await provider.getIssue('SDDAMICO-HIC');
	expect(again?.identifier).toBe('sddamico-hic');
	expect(calls.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Status normalization

test('normalizeBeadsStatus folds every spelling a watchlist arrives in', () => {
	expect(normalizeBeadsStatus('in_progress')).toBe('in_progress');
	expect(normalizeBeadsStatus('In Progress')).toBe('in_progress');
	expect(normalizeBeadsStatus('  IN   PROGRESS  ')).toBe('in_progress');
	expect(normalizeBeadsStatus('Open')).toBe('open');
	expect(normalizeBeadsStatus('')).toBe('');
});

test('the reachability warning and the watchlist filter read a status alike', async () => {
	// These used to normalize differently — the warning folded whitespace to
	// underscores, the filter did not — so one spelling could be reported as
	// unreachable and still match, or the reverse.
	for (const spelling of ['open', 'Open', ' OPEN ']) {
		const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
		expect(unreachableReadyStatuses([spelling])).toStrictEqual([]);
		const matched = await provider.searchAssignedIssues(undefined, [spelling]);
		expect(matched.length).toBe(1);
	}

	for (const spelling of ['in_progress', 'In Progress', 'in progress']) {
		const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
		expect(unreachableReadyStatuses([spelling])).toStrictEqual([spelling]);
		const matched = await provider.searchAssignedIssues(undefined, [spelling]);
		expect(matched.length).toBe(0);
	}
});

// listStates / setIssueState

const STATUSES = JSON.stringify({
	schema_version: 1,
	data: {
		built_in_statuses: [
			{name: 'open', category: 'active'},
			{name: 'in_progress', category: 'wip'},
			{name: 'closed', category: 'done'},
			{name: 'deferred', category: 'frozen'},
			{name: 'pinned', category: 'frozen'},
			{name: 'hooked', category: 'wip'},
		],
		custom_statuses: [{name: 'in_review', category: 'done'}, {name: 'triage'}],
	},
});

test('listStates reads built-in and custom statuses, marks the done category and skips agent-workflow ones', async () => {
	const {provider, calls} = providerReturning(STATUSES);
	expect(await provider.listStates()).toStrictEqual([
		{id: 'open', name: 'Open', done: false},
		{id: 'in_progress', name: 'In Progress', done: false},
		{id: 'closed', name: 'Closed', done: true},
		{id: 'deferred', name: 'Deferred', done: false},
		{id: 'in_review', name: 'In Review', done: true},
		{id: 'triage', name: 'Triage', done: false},
	]);
	expect(calls[0]).toStrictEqual(['statuses', '--json']);

	await provider.listStates();
	expect(calls.length).toBe(1);
});

test('listStates returns nothing on failure and asks again next time', async () => {
	const {provider, calls} = providerReturning(new Error('boom'), STATUSES);
	expect(await provider.listStates()).toStrictEqual([]);
	const retried = await provider.listStates();
	expect(retried.length).toBe(6);
	expect(calls.length).toBe(2);
});

test('setIssueState updates the status, and closed goes through bd close', async () => {
	const {provider, calls} = providerReturning('', '');
	expect(await provider.setIssueState('-weird-xyz', 'deferred')).toBe(true);
	expect(await provider.setIssueState('-weird-xyz', 'closed')).toBe(true);
	expect(calls).toStrictEqual([
		['update', '--status=deferred', '--', '-weird-xyz'],
		['close', '--', '-weird-xyz'],
	]);
});

test('setIssueState reports a failed write', async () => {
	expect(
		await providerReturning(new Error('blocked')).provider.setIssueState(
			'bd-1',
			'deferred',
		),
	).toBe(false);
	expect(
		await providerReturning(makeEnoentError()).provider.setIssueState(
			'bd-1',
			'deferred',
		),
	).toBe(false);
});

test('a bead that keeps failing to load warns once, not on every refresh', async () => {
	clearRecentErrors();
	const {provider} = providerReturning(new Error('no issue found'));
	for (let refresh = 0; refresh < 5; refresh++) {
		provider.clearCache();
		await provider.getIssue('qa-gone');
	}

	const warnings = getRecentErrors().filter(e =>
		e.message.startsWith('Failed to fetch beads issue qa-gone'),
	);
	expect(warnings.length).toBe(1);
});
