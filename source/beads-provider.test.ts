import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
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
	unwrapBeadsJson,
	type CliExecutor,
	type SleepFn,
} from './providers/beads-provider.ts';
import {StateColorCache} from './providers/state-color-cache.ts';
import {buildPopupCommand} from './tmux.ts';

function makeEnoentError(): Error & {code: string} {
	const err = new Error('spawn bd ENOENT') as Error & {code: string};
	err.code = 'ENOENT';
	return err;
}

// No-op sleep so tests don't wait
const noopSleep: SleepFn = async () => {};

let tempCounter = 0;
function tempCachePath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-beads-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

function tempCache(): StateColorCache {
	return new StateColorCache(tempCachePath());
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

test('unwrapBeadsJson reads a bare array (legacy --json)', t => {
	const rows = unwrapBeadsJson(JSON.stringify([OPEN_ISSUE]));
	t.is(rows.length, 1);
	t.is(rows[0]!['id'], 'sddamico-hic');
});

test('unwrapBeadsJson unwraps the schema envelope', t => {
	// BD_JSON_ENVELOPE=1 today, the default from beads 2.0 on.
	const rows = unwrapBeadsJson(
		JSON.stringify({schema_version: 1, data: [OPEN_ISSUE]}),
	);
	t.is(rows.length, 1);
	t.is(rows[0]!['id'], 'sddamico-hic');
});

test('unwrapBeadsJson wraps a lone object into a list', t => {
	const rows = unwrapBeadsJson(JSON.stringify(OPEN_ISSUE));
	t.is(rows.length, 1);
	t.is(rows[0]!['title'], "better-sqlite3 can't build");
});

test('unwrapBeadsJson unwraps an enveloped lone object', t => {
	const rows = unwrapBeadsJson(
		JSON.stringify({schema_version: 1, data: OPEN_ISSUE}),
	);
	t.is(rows.length, 1);
	t.is(rows[0]!['id'], 'sddamico-hic');
});

test('unwrapBeadsJson returns nothing for an empty or scalar payload', t => {
	t.deepEqual(unwrapBeadsJson('[]'), []);
	t.deepEqual(unwrapBeadsJson('null'), []);
	t.deepEqual(unwrapBeadsJson('"nope"'), []);
});

test('unwrapBeadsJson drops non-object rows rather than mapping them', t => {
	const rows = unwrapBeadsJson(JSON.stringify([OPEN_ISSUE, null, 3]));
	t.is(rows.length, 1);
});

// beadsIssuePrefix — the stand-in for Linear/Jira's project field

test('beadsIssuePrefix splits on the last hyphen', t => {
	t.is(beadsIssuePrefix('bd-a1b2'), 'bd');
	t.is(beadsIssuePrefix('sddamico-hic'), 'sddamico');
});

test('beadsIssuePrefix keeps hyphens inside the prefix', t => {
	// The prefix defaults to the repo directory name, which routinely has them.
	t.is(
		beadsIssuePrefix('seatgeek-ticket-management-cli-bqm'),
		'seatgeek-ticket-management-cli',
	);
});

test('beadsIssuePrefix ignores hierarchical child suffixes', t => {
	t.is(beadsIssuePrefix('bd-a3f8e9.1'), 'bd');
	t.is(beadsIssuePrefix('bd-a3f8e9.1.2'), 'bd');
});

test('beadsIssuePrefix returns empty for an ID with no hyphen', t => {
	t.is(beadsIssuePrefix('nohyphen'), '');
});

// Status mapping

test('beadsStateType reports closed as completed for auto-remove', t => {
	// auto-remove.ts keys off the Linear-flavored 'completed'/'canceled'.
	t.is(beadsStateType('closed'), 'completed');
});

test('beadsStateType passes every other status through untouched', t => {
	// Including user-defined ones, which beads allows via its status.custom key.
	for (const status of ['open', 'in_progress', 'blocked', 'needs_review']) {
		t.is(beadsStateType(status), status);
	}
});

test('beadsStateName title-cases the snake_case status', t => {
	t.is(beadsStateName('in_progress'), 'In Progress');
	t.is(beadsStateName('open'), 'Open');
});

// mapBeadsIssue — pure parsing logic

test('mapBeadsIssue maps a standard bd row', t => {
	const issue = mapBeadsIssue(OPEN_ISSUE);
	t.is(issue.identifier, 'sddamico-hic');
	t.is(issue.title, "better-sqlite3 can't build");
	t.is(issue.state.name, 'Open');
	t.is(issue.state.type, 'open');
	t.is(issue.state.color, 'gray');
});

test('mapBeadsIssue never uppercases the identifier', t => {
	// A beads ID is case-sensitive; uppercasing yields one bd cannot resolve.
	t.is(mapBeadsIssue({id: 'bd-a1b2', title: 'x'}).identifier, 'bd-a1b2');
});

test('mapBeadsIssue exposes the prefix as the project', t => {
	const issue = mapBeadsIssue({id: 'sddamico-hic', title: 'x', status: 'open'});
	t.deepEqual(issue.project, {name: 'sddamico', key: 'sddamico'});
});

test('mapBeadsIssue reports no project for a prefixless ID', t => {
	t.is(mapBeadsIssue({id: 'nohyphen', title: 'x'}).project, null);
});

test('mapBeadsIssue maps a closed issue to the terminal state type', t => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, status: 'closed'});
	t.is(issue.state.type, 'completed');
	t.is(issue.state.name, 'Closed');
	t.is(issue.state.color, 'green');
});

test('mapBeadsIssue gives an unknown status the fallback color', t => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, status: 'needs_review'});
	t.is(issue.state.name, 'Needs Review');
	t.is(issue.state.color, 'gray');
});

test('mapBeadsIssue keeps string labels and drops the rest', t => {
	const issue = mapBeadsIssue({...OPEN_ISSUE, labels: ['bug', 7, 'infra']});
	t.deepEqual(issue.labels, ['bug', 'infra']);
});

test('mapBeadsIssue omits labels when bd sent none', t => {
	t.is(mapBeadsIssue(OPEN_ISSUE).labels, undefined);
});

test('mapBeadsIssue tolerates a row missing title and status', t => {
	const issue = mapBeadsIssue({id: 'bd-a1b2'});
	t.is(issue.title, '');
	t.is(issue.state.type, 'open');
});

// getIssue

test('getIssue fetches and maps an issue', async t => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issue = await provider.getIssue('sddamico-hic');
	t.is(issue?.title, "better-sqlite3 can't build");
	t.deepEqual(calls[0], ['show', '--id=sddamico-hic', '--json']);
});

test('getIssue picks the row whose id was asked for', async t => {
	const other = {...OPEN_ISSUE, id: 'sddamico-zzz', title: 'Other'};
	const {provider} = providerReturning(
		JSON.stringify([other, {...OPEN_ISSUE, title: 'Wanted'}]),
	);
	const issue = await provider.getIssue('sddamico-hic');
	t.is(issue?.title, 'Wanted');
});

test('getIssue returns null when bd reports no rows', async t => {
	const {provider} = providerReturning('[]');
	t.is(await provider.getIssue('sddamico-nope'), null);
});

test('getIssue serves a second call from cache', async t => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	await provider.getIssue('sddamico-hic');
	await provider.getIssue('sddamico-hic');
	t.is(calls.length, 1);
});

test('getIssue retries a failing bd call', async t => {
	const {provider, calls} = providerReturning(
		new Error('database locked'),
		JSON.stringify([OPEN_ISSUE]),
	);
	const issue = await provider.getIssue('sddamico-hic');
	t.is(issue?.title, "better-sqlite3 can't build");
	t.is(calls.length, 2);
});

test('getIssue gives up after MAX_RETRIES', async t => {
	const {provider, calls} = providerReturning(new Error('nope'));
	t.is(await provider.getIssue('sddamico-hic'), null);
	t.is(calls.length, MAX_RETRIES);
});

test('a missing bd binary disables the provider instead of retrying', async t => {
	const {provider, calls} = providerReturning(makeEnoentError());
	t.is(await provider.getIssue('sddamico-hic'), null);
	t.is(await provider.getIssue('sddamico-other'), null);
	// One attempt total: ENOENT is sticky, and no retry can fix it.
	t.is(calls.length, 1);
});

// getIssues

test('getIssues fetches a batch in one bd list call', async t => {
	const second = {...OPEN_ISSUE, id: 'sddamico-ck8', title: 'Second'};
	const {provider, calls} = providerReturning(
		JSON.stringify([OPEN_ISSUE, second]),
	);
	const map = await provider.getIssues(['sddamico-hic', 'sddamico-ck8']);
	t.is(map.get('sddamico-hic')?.title, "better-sqlite3 can't build");
	t.is(map.get('sddamico-ck8')?.title, 'Second');
	t.deepEqual(calls[0], [
		'list',
		'--id=sddamico-hic,sddamico-ck8',
		'--json',
		'-n',
		'0',
	]);
});

test('getIssues resolves keys the batch missed individually', async t => {
	const {provider, calls} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		JSON.stringify([{...OPEN_ISSUE, id: 'sddamico-ck8', title: 'Second'}]),
	);
	const map = await provider.getIssues(['sddamico-hic', 'sddamico-ck8']);
	t.is(map.get('sddamico-ck8')?.title, 'Second');
	t.is(calls[1]?.[0], 'show');
});

test('getIssues falls back to individual fetches when the batch errors', async t => {
	let call = 0;
	const exec: CliExecutor = async (_cmd, args) => {
		call++;
		if (args[0] === 'list') throw new Error('bad flag');
		return JSON.stringify([OPEN_ISSUE]);
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	const map = await provider.getIssues(['sddamico-hic']);
	t.is(map.get('sddamico-hic')?.title, "better-sqlite3 can't build");
	t.true(call > 1);
});

test('getIssues short-circuits on an empty key list', async t => {
	const {provider, calls} = providerReturning('[]');
	const map = await provider.getIssues([]);
	t.is(map.size, 0);
	t.is(calls.length, 0);
});

// searchAssignedIssues — the watchlist, sourced from `bd ready`

test('searchAssignedIssues reads bd ready', async t => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issues = await provider.searchAssignedIssues(undefined, []);
	t.is(issues.length, 1);
	t.deepEqual(calls[0], [
		'ready',
		'--json',
		'-n',
		'0',
		'--exclude-type',
		'epic,convoy,molecule,event,merge-request',
	]);
});

test('searchAssignedIssues narrows bd ready by configured status', async t => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, ['open']);
	t.deepEqual(
		issues.map(i => i.identifier),
		['sddamico-hic'],
	);
});

test('searchAssignedIssues matches a status by display name too', async t => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, [
		'In Progress',
	]);
	t.deepEqual(
		issues.map(i => i.identifier),
		['sddamico-ck8'],
	);
});

test('searchAssignedIssues takes every ready issue when no status is set', async t => {
	const started = {...OPEN_ISSUE, id: 'sddamico-ck8', status: 'in_progress'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, started]));
	const issues = await provider.searchAssignedIssues(undefined, []);
	t.is(issues.length, 2);
});

test('searchAssignedIssues passes an explicit assignee through', async t => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues('alice@example.com', []);
	t.deepEqual(calls[0], [
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
test('the watchlist does not offer a container or a bookkeeping row', async t => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues(undefined, []);
	const argv = calls[0]!;
	const excluded = argv[argv.indexOf('--exclude-type') + 1]!.split(',');
	t.deepEqual(excluded, [
		'epic',
		'convoy',
		'molecule',
		'event',
		'merge-request',
	]);
});

// A person is choosing in the picker, and opening a worktree against a
// container to work through its children is a legitimate thing to want.
test('the picker still offers a container row', async t => {
	const {provider, calls} = providerReturning('[]');
	await provider.listReadyIssues();
	t.false(calls[0]!.includes('--exclude-type'));
});

// Writing an ADR produces a real diff, so a decision is work like any other.
test('a decision is still offered to the watchlist', async t => {
	const {provider, calls} = providerReturning('[]');
	await provider.searchAssignedIssues(undefined, []);
	const argv = calls[0]!;
	t.false(
		argv[argv.indexOf('--exclude-type') + 1]!.split(',').includes('decision'),
	);
});

test('searchAssignedIssues resolves "me" from the environment', async t => {
	const previous = process.env['BEADS_ACTOR'];
	process.env['BEADS_ACTOR'] = 'charlie';
	try {
		const {provider, calls} = providerReturning('[]');
		await provider.searchAssignedIssues('me', []);
		t.true(calls[0]!.includes('charlie'));
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
test('searchAssignedIssues resolves "me" through git user.name', async t => {
	const previousActor = process.env['BEADS_ACTOR'];
	delete process.env['BEADS_ACTOR'];
	try {
		const {provider, calls} = providerWithGit('Ada Lovelace');
		await provider.searchAssignedIssues('me', []);
		t.true(calls[0]!.includes('Ada Lovelace'));
	} finally {
		if (previousActor !== undefined) {
			process.env['BEADS_ACTOR'] = previousActor;
		}
	}
});

test('searchAssignedIssues falls back to $USER with no git identity', async t => {
	const previousActor = process.env['BEADS_ACTOR'];
	const previousUser = process.env['USER'];
	delete process.env['BEADS_ACTOR'];
	process.env['USER'] = 'ada';
	try {
		const {provider, calls} = providerWithGit(new Error('no user.name set'));
		await provider.searchAssignedIssues('me', []);
		t.true(calls[0]!.includes('ada'));
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

test('a status bd ready cannot return yields an empty watchlist', async t => {
	// `bd ready` excludes in_progress/blocked/deferred/hooked by construction,
	// so it only ever hands back open issues. A watchlist config carried over
	// from Linear ("In Progress") therefore matches nothing — the provider warns
	// (see unreachableReadyStatuses) rather than failing.
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	t.deepEqual(
		await provider.searchAssignedIssues(undefined, ['in_progress']),
		[],
	);
});

test('unreachableReadyStatuses flags statuses bd ready never returns', t => {
	t.deepEqual(unreachableReadyStatuses(['open']), []);
	t.deepEqual(unreachableReadyStatuses(['in_progress']), ['in_progress']);
	// Display-name spelling, as a Linear/Jira watchlist would write it.
	t.deepEqual(unreachableReadyStatuses(['In Progress']), ['In Progress']);
	t.deepEqual(unreachableReadyStatuses(['Open', 'blocked']), ['blocked']);
	t.deepEqual(unreachableReadyStatuses([]), []);
});

test('searchAssignedIssues returns nothing when bd is missing', async t => {
	const {provider} = providerReturning(makeEnoentError());
	t.deepEqual(await provider.searchAssignedIssues(undefined, []), []);
});

// listReadyIssues

test('listReadyIssues reads bd ready with no assignee filter', async t => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	const issues = await provider.listReadyIssues();
	t.deepEqual(
		issues.map(i => i.identifier),
		['sddamico-hic'],
	);
	t.deepEqual(calls[0], ['ready', '--json', '-n', '0']);
});

// Unlike the watchlist, the picker keeps whatever bd ready hands back: beads
// issues are usually unassigned until claimed, so any narrowing would empty it.
test('listReadyIssues keeps every row bd ready returns', async t => {
	const other = {...OPEN_ISSUE, id: 'sddamico-ck8', assignee: 'someone-else'};
	const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE, other]));
	const issues = await provider.listReadyIssues();
	t.deepEqual(
		issues.map(i => i.identifier),
		['sddamico-hic', 'sddamico-ck8'],
	);
});

test('listReadyIssues returns nothing when bd is missing', async t => {
	const {provider} = providerReturning(makeEnoentError());
	t.deepEqual(await provider.listReadyIssues(), []);
});

test('listReadyIssues returns nothing when bd fails', async t => {
	const {provider} = providerReturning(new Error('bd exploded'));
	t.deepEqual(await provider.listReadyIssues(), []);
});

test('listReadyIssues skips malformed rows and keeps the valid ones', async t => {
	const {provider} = providerReturning(
		JSON.stringify([{nonsense: true}, OPEN_ISSUE]),
	);
	const issues = await provider.listReadyIssues();
	t.deepEqual(
		issues.map(i => i.identifier),
		['sddamico-hic'],
	);
});

// closeIssue

test('closeIssue runs bd close', async t => {
	const {provider, calls} = providerReturning('');
	t.true(await provider.closeIssue('sddamico-hic'));
	t.deepEqual(calls[0], ['close', '--', 'sddamico-hic']);
});

// The escape is not decoration: `bd show -weird-xyz` dies with "unknown
// shorthand flag: 'e'". close/update/comments add have no --id of their own,
// so `--` is the only thing standing between a dash-led prefix and the parser.
test("the id is fenced off from bd's flag parser", async t => {
	const {provider, calls} = providerReturning('', '', '');
	await provider.closeIssue('-weird-xyz');
	await provider.claimIssue('-weird-xyz');
	for (const argv of calls) {
		t.is(argv.at(-1), '-weird-xyz');
		t.is(argv.at(-2), '--');
	}
});

test('closeIssue drops the cached copy so the next read comes from bd', async t => {
	const {provider} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		'',
		makeEnoentError(),
	);
	await provider.getIssue('sddamico-hic');
	await provider.closeIssue('sddamico-hic');

	// bd is gone by this point, so a surviving cache entry is the only way
	// getIssue could still answer.
	t.is(await provider.getIssue('sddamico-hic'), null);
});

test('closeIssue reports failure when bd fails', async t => {
	const {provider} = providerReturning(new Error('bd exploded'));
	t.false(await provider.closeIssue('sddamico-hic'));
});

test('closeIssue reports failure when bd is missing', async t => {
	const {provider} = providerReturning(makeEnoentError());
	t.false(await provider.closeIssue('sddamico-hic'));
});

// claimIssue

test('claimIssue runs bd update --claim', async t => {
	const {provider, calls} = providerReturning('');
	t.true(await provider.claimIssue('sddamico-hic'));
	t.deepEqual(calls[0], ['update', '--claim', '--', 'sddamico-hic']);
});

test('claimIssue runs from the main repo root, not the caller cwd', async t => {
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
	t.is(seenCwd, REPO_ROOT);
});

test('claimIssue drops the cached copy so the next read sees in_progress', async t => {
	const {provider} = providerReturning(
		JSON.stringify([OPEN_ISSUE]),
		'',
		makeEnoentError(),
	);
	await provider.getIssue('sddamico-hic');
	await provider.claimIssue('sddamico-hic');

	// bd is gone by this point, so a surviving cache entry is the only way
	// getIssue could still answer — and it would answer "open".
	t.is(await provider.getIssue('sddamico-hic'), null);
});

test('claimIssue reports failure when bd fails', async t => {
	const {provider} = providerReturning(new Error('bd exploded'));
	t.false(await provider.claimIssue('sddamico-hic'));
});

test('claimIssue reports failure when bd is missing', async t => {
	const {provider} = providerReturning(makeEnoentError());
	t.false(await provider.claimIssue('sddamico-hic'));
});

// createComment

test('createComment hands bd a file holding the body', async t => {
	let bodyPath = '';
	let seen = '';
	const exec: CliExecutor = async (_cmd, args) => {
		bodyPath = args[args.indexOf('-f') + 1]!;
		seen = fs.readFileSync(bodyPath, 'utf-8');
		return '';
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	t.true(await provider.createComment('bd-a1b2', '### Answered\n\nyes'));
	t.is(seen, '### Answered\n\nyes');
	// The staging file is cleaned up regardless of outcome.
	t.false(fs.existsSync(bodyPath));
});

test('createComment retries then reports failure', async t => {
	const {provider, calls} = providerReturning(new Error('locked'));
	t.false(await provider.createComment('bd-a1b2', 'body'));
	t.is(calls.length, MAX_RETRIES);
});

test('createComment gives up immediately when bd is missing', async t => {
	const {provider, calls} = providerReturning(makeEnoentError());
	t.false(await provider.createComment('bd-a1b2', 'body'));
	t.is(calls.length, 1);
});

// Misc surface

test('openIssue reports failure outside tmux', t => {
	const previous = process.env['TMUX'];
	delete process.env['TMUX'];
	try {
		const {provider} = providerReturning('[]');
		t.false(provider.openIssue('bd-a1b2'));
	} finally {
		if (previous !== undefined) process.env['TMUX'] = previous;
	}
});

test('openIssue popup is pinned to the main repo root', t => {
	// A popup launched from a worktree pane would otherwise read that worktree's
	// checked-out .beads/ copy instead of the database the rail is showing.
	const argv = buildIssuePopupArgv(REPO_ROOT, 'bd-a1b2');
	t.is(argv[argv.indexOf('-C') + 1], REPO_ROOT);
});

test('issue popup output goes through a pager', t => {
	// display-popup -E tears the popup down the moment its command exits, and
	// `bd show` prints and exits immediately — without the pager the popup
	// flashes for a single frame and the issue is never readable.
	const command = buildPopupCommand(buildIssuePopupArgv(REPO_ROOT, 'bd-a1b2'));
	t.true(command.includes("'bd' '-C'"));
	t.true(command.endsWith('| less -R'));
	t.false(command.includes('-F'));
});

test('getWorkflowStateColor resolves a display name back to its color', async t => {
	const {provider} = providerReturning(
		JSON.stringify([{...OPEN_ISSUE, status: 'in_progress'}]),
	);
	await provider.getIssue('sddamico-hic');
	t.is(provider.getWorkflowStateColor('In Progress'), 'blue');
});

test('getWorkflowStateColor answers for a state never fetched', t => {
	const {provider} = providerReturning('[]');
	t.is(provider.getWorkflowStateColor('Blocked'), 'yellow');
	t.is(provider.getWorkflowStateColor('Nonsense'), null);
});

test('clearCache forces the next getIssue back to bd', async t => {
	const {provider, calls} = providerReturning(JSON.stringify([OPEN_ISSUE]));
	await provider.getIssue('sddamico-hic');
	provider.clearCache();
	await provider.getIssue('sddamico-hic');
	t.is(calls.length, 2);
});

test('bd runs from the repo root with the JSON envelope requested', async t => {
	let options: {cwd: string; env: NodeJS.ProcessEnv} | undefined;
	const exec: CliExecutor = async (_cmd, _args, opts) => {
		options = opts;
		return '[]';
	};
	const provider = new BeadsProvider(exec, noopSleep, tempCache(), resolveCwd);
	await provider.getIssue('sddamico-hic');
	// Every worktree must read the one canonical database at the repo root.
	t.is(options?.cwd, REPO_ROOT);
	t.is(options?.env['BD_JSON_ENVELOPE'], '1');
});

// ---------------------------------------------------------------------------
// Cache keying

test('a row bd spells differently is cached under the key we asked for', async t => {
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
	t.is(fetched?.identifier, 'sddamico-hic');
	t.is(provider.getIssueCached('SDDAMICO-HIC')?.identifier, 'sddamico-hic');
	t.is(provider.getIssueCached('sddamico-hic')?.identifier, 'sddamico-hic');

	// bd is gone by now, so a second answer can only come from the cache.
	const again = await provider.getIssue('SDDAMICO-HIC');
	t.is(again?.identifier, 'sddamico-hic');
	t.is(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Status normalization

test('normalizeBeadsStatus folds every spelling a watchlist arrives in', t => {
	t.is(normalizeBeadsStatus('in_progress'), 'in_progress');
	t.is(normalizeBeadsStatus('In Progress'), 'in_progress');
	t.is(normalizeBeadsStatus('  IN   PROGRESS  '), 'in_progress');
	t.is(normalizeBeadsStatus('Open'), 'open');
	t.is(normalizeBeadsStatus(''), '');
});

test('the reachability warning and the watchlist filter read a status alike', async t => {
	// These used to normalize differently — the warning folded whitespace to
	// underscores, the filter did not — so one spelling could be reported as
	// unreachable and still match, or the reverse.
	for (const spelling of ['open', 'Open', ' OPEN ']) {
		const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
		t.deepEqual(unreachableReadyStatuses([spelling]), []);
		const matched = await provider.searchAssignedIssues(undefined, [spelling]);
		t.is(matched.length, 1);
	}

	for (const spelling of ['in_progress', 'In Progress', 'in progress']) {
		const {provider} = providerReturning(JSON.stringify([OPEN_ISSUE]));
		t.deepEqual(unreachableReadyStatuses([spelling]), [spelling]);
		const matched = await provider.searchAssignedIssues(undefined, [spelling]);
		t.is(matched.length, 0);
	}
});
