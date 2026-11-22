import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test, {type ExecutionContext} from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {
	newSpaceIdentity,
	protectedSessionNames,
	worktreePathFor,
	type SpaceIdentity,
} from './space-identity.ts';
import {stateDbPath} from './state-db.ts';

const SOCKET = 'identity-test-socket';

/** Stores with a home of their own, and the identities idow would give its spaces. */
function fixture(t: ExecutionContext, sqlite?: boolean) {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-identity-')),
	);
	t.teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const mainRoot = path.join(home, 'workspace', 'repo');
	fs.mkdirSync(path.join(mainRoot, 'src'), {recursive: true});
	const state = testState(t, {
		sqlite,
		home,
		env: {PAPPARDELLE_TMUX_SOCKET: SOCKET},
		mainRoot: () => mainRoot,
	});
	const identity = (key: string): SpaceIdentity =>
		newSpaceIdentity({
			repo: state.repo,
			key,
			worktreePath:
				key === 'main' ? mainRoot : worktreePathFor(home, state.repo, key),
			socket: SOCKET,
		});
	/** A space as idow opens it: identity recorded, worktree made, registered. */
	const open = async (key: string) => {
		const made = identity(key);
		fs.mkdirSync(made.worktreePath, {recursive: true});
		if (key === 'main') {
			fs.writeFileSync(path.join(mainRoot, '.pappardelle.yml'), 'version: 1\n');
		}

		await state.daos.spaceIdentities.record(made);
		if (key !== 'main') await state.daos.registry.add(key);
		return made;
	};

	return {home, mainRoot, state, identity, open};
}

function contractFixture(t: ExecutionContext, state: TestState) {
	return fixture(t, state.sqlite);
}

contractTest(
	'a space is found under the names it was opened with',
	async (t, state) => {
		const f = contractFixture(t, state);
		for (const key of ['a.b_c', 'bd-a3f8e9.1', 'main']) {
			const opened = await f.open(key);
			t.deepEqual(f.state.daos.spaceIdentities.get(key), {
				kind: 'identity',
				identity: opened,
			});
		}

		t.is(f.identity('a.b_c').tmux.agentSession, 'agent-repo-a_b__c');
	},
);

contractTest('main is listed with the open spaces', async (t, state) => {
	const f = contractFixture(t, state);
	await f.open('main');
	await f.open('STA-1');
	const listed = f.state.daos.spaceIdentities.list();
	t.is(listed.kind, 'identities');
	if (listed.kind !== 'identities') return;
	t.deepEqual(listed.identities.map(identity => identity.key).sort(), [
		'STA-1',
		'main',
	]);
});

contractTest(
	'a path is in the space whose worktree holds it, through a symlink too',
	async (t, state) => {
		const f = contractFixture(t, state);
		await f.open('main');
		const opened = await f.open('STA-1');
		const deep = path.join(opened.worktreePath, 'packages', 'app');
		fs.mkdirSync(deep, {recursive: true});
		const link = path.join(f.home, 'link');
		fs.symlinkSync(path.join(opened.worktreePath, 'packages'), link);
		const {spaceIdentities} = f.state.daos;

		t.deepEqual(spaceIdentities.atPath(deep), {
			kind: 'identity',
			identity: opened,
		});
		t.deepEqual(spaceIdentities.atPath(path.join(link, 'app')), {
			kind: 'identity',
			identity: opened,
		});
		t.is(
			(
				spaceIdentities.atPath(path.join(f.mainRoot, 'src')) as {
					identity: SpaceIdentity;
				}
			).identity.key,
			'main',
		);
		t.deepEqual(spaceIdentities.atPath(f.home), {kind: 'unknown'});
	},
);

test('a key never opened has no identity', t => {
	const f = fixture(t, true);
	t.deepEqual(f.state.daos.spaceIdentities.get('STA-9'), {kind: 'unknown'});
});

test('a closed space keeps its identity', async t => {
	const f = fixture(t, true);
	await f.open('main');
	const opened = await f.open('STA-1');
	await f.state.daos.registry.remove('STA-1');
	t.deepEqual(f.state.daos.spaceIdentities.get('STA-1'), {
		kind: 'identity',
		identity: opened,
	});
	const listed = f.state.daos.spaceIdentities.list();
	t.deepEqual(
		listed.kind === 'identities' &&
			listed.identities.map(identity => identity.key),
		['main', 'STA-1'],
	);
});

test('a space whose worktree is not where idow puts them is found where it is', async t => {
	const f = fixture(t, true);
	const custom = path.join(f.home, 'custom', 'path');
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('state-cli.ts', import.meta.url)),
			'prepare-space',
			'--repo',
			'repo',
			'--worktree',
			custom,
			'--main-root',
			f.mainRoot,
			'STA-1',
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				PAPPARDELLE_SQLITE_STATE: '1',
				PAPPARDELLE_STATE_DB: stateDbPath(f.state.stateDir),
				PAPPARDELLE_TMUX_SOCKET: SOCKET,
			},
		},
	);
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.deepEqual(f.state.daos.spaceIdentities.get('STA-1'), {
		kind: 'identity',
		identity: {...f.identity('STA-1'), worktreePath: custom},
	});
	t.deepEqual(f.state.daos.spaceIdentities.get('main'), {
		kind: 'identity',
		identity: f.identity('main'),
	});
});

test('a space opened without the database is given the identity idow gave it, along with main', t => {
	const f = fixture(t, true);
	fs.writeFileSync(f.state.registryFile, JSON.stringify(['STA-1']));
	t.deepEqual(f.state.daos.spaceIdentities.get('STA-1'), {
		kind: 'identity',
		identity: f.identity('STA-1'),
	});
	t.deepEqual(f.state.daos.spaceIdentities.get('main'), {
		kind: 'identity',
		identity: f.identity('main'),
	});
});

contractTest(
	'a checkout with no Pappardelle config or stored identity belongs to no space',
	(t, state) => {
		const f = contractFixture(t, state);
		t.deepEqual(
			f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')),
			{kind: 'unknown'},
		);
	},
);

contractTest(
	'a repo with .pappardelle.yml resolves main even before any spaces are opened',
	(t, state) => {
		const f = contractFixture(t, state);
		fs.writeFileSync(path.join(f.mainRoot, '.pappardelle.yml'), 'version: 1\n');
		t.deepEqual(f.state.daos.spaceIdentities.get('main'), {
			kind: 'identity',
			identity: f.identity('main'),
		});
		t.deepEqual(
			f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')),
			{kind: 'identity', identity: f.identity('main')},
		);
	},
);

test('importing another repo from an unrelated checkout does not seed main with the wrong path', t => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-identity-cross-')),
	);
	t.teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const otherRepo = path.join(home, 'workspace', 'other-repo');
	fs.mkdirSync(otherRepo, {recursive: true});
	fs.writeFileSync(path.join(otherRepo, '.pappardelle.yml'), 'version: 1\n');
	const state = testState(t, {
		repo: 'target-repo',
		sqlite: true,
		home,
		env: {PAPPARDELLE_TMUX_SOCKET: SOCKET},
		mainRoot: () => otherRepo,
	});
	fs.writeFileSync(state.registryFile, JSON.stringify(['STA-1']));
	t.deepEqual(state.daos.spaceIdentities.get('main'), {kind: 'unknown'});
});

test('importing open-spaces outside a git checkout still seeds main on a later read inside it', t => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-identity-retry-')),
	);
	t.teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const mainRoot = path.join(home, 'workspace', 'repo');
	fs.mkdirSync(mainRoot, {recursive: true});
	let inCheckout = false;
	const state = testState(t, {
		repo: 'repo',
		sqlite: true,
		home,
		env: {PAPPARDELLE_TMUX_SOCKET: SOCKET},
		mainRoot() {
			if (!inCheckout) throw new Error('Not in a git repository');
			return mainRoot;
		},
	});
	fs.writeFileSync(state.registryFile, JSON.stringify(['STA-1']));
	t.deepEqual(state.daos.spaceIdentities.get('main'), {kind: 'unknown'});
	inCheckout = true;
	const lookup = state.daos.spaceIdentities.get('main');
	t.is(lookup.kind, 'identity');
	if (lookup.kind === 'identity') {
		t.is(lookup.identity.worktreePath, mainRoot);
	}
});

test('two keys cannot share an agent session', async t => {
	const f = fixture(t, true);
	await f.open('a.b');
	const other = f.identity('other');
	const clash = {
		...other,
		tmux: {...other.tmux, agentSession: f.identity('a.b').tmux.agentSession},
	};
	await t.throwsAsync(f.state.daos.spaceIdentities.record(clash), {
		message: /UNIQUE/,
	});
});

test('the reaper keeps the stored names of main and every protected space', async t => {
	const f = fixture(t, true);
	await f.open('main');
	await f.state.daos.spaceIdentities.record({
		...f.identity('STA-1'),
		tmux: {
			socket: SOCKET,
			agentSession: 'hand-named-agent',
			companionSession: 'hand-named-companion',
		},
	});
	await f.state.daos.registry.reserveStart('STA-1', process.pid);
	const owned = protectedSessionNames(
		f.state.daos.registry,
		f.state.daos.spaceIdentities,
	);
	t.deepEqual(owned.kind === 'names' ? [...owned.names].sort() : owned, [
		'agent-repo-main',
		'companion-repo-main',
		'hand-named-agent',
		'hand-named-companion',
	]);
});

test('a protected space without stored names stops the reap', async t => {
	const f = fixture(t, true);
	await f.open('main');
	await f.state.daos.registry.add('STA-1');
	t.deepEqual(
		protectedSessionNames(f.state.daos.registry, f.state.daos.spaceIdentities),
		{kind: 'missing', keys: ['STA-1']},
	);
});

test('identities that cannot be read stop the reap', t => {
	const f = fixture(t, true);
	const error = new Error('locked');
	t.deepEqual(
		protectedSessionNames(f.state.daos.registry, {
			list: () => ({kind: 'unreadable', error}),
		}),
		{kind: 'unreadable', error},
	);
});

test('a space keeps the names it was first given', async t => {
	const f = fixture(t, true);
	const first = await f.open('STA-1');
	await f.state.daos.spaceIdentities.record({
		...first,
		worktreePath: '/elsewhere',
		tmux: {...first.tmux, socket: 'another-socket'},
	});
	t.deepEqual(f.state.daos.spaceIdentities.get('STA-1'), {
		kind: 'identity',
		identity: first,
	});
});

test('main follows its checkout when a TUI starts there, not when a space is opened', async t => {
	const f = fixture(t, true);
	const first = await f.open('main');
	const moved = {
		...first,
		worktreePath: '/moved/repo',
		tmux: {...first.tmux, socket: 'another-socket'},
	};
	await f.state.daos.spaceIdentities.record(moved);
	t.deepEqual(f.state.daos.spaceIdentities.get('main'), {
		kind: 'identity',
		identity: first,
	});
	await f.state.daos.spaceIdentities.moveMain(moved);
	t.deepEqual(f.state.daos.spaceIdentities.get('main'), {
		kind: 'identity',
		identity: moved,
	});
});

contractTest(
	'a path in a checkout nested in a worktree belongs to no space',
	async (t, state) => {
		const f = contractFixture(t, state);
		await f.open('main');
		const nested = path.join(f.mainRoot, '.claude', 'worktrees', 'agent-x');
		fs.mkdirSync(path.join(nested, 'src'), {recursive: true});
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: elsewhere\n');
		t.deepEqual(f.state.daos.spaceIdentities.atPath(path.join(nested, 'src')), {
			kind: 'unknown',
		});
		t.is(
			(
				f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')) as {
					identity: SpaceIdentity;
				}
			).identity.key,
			'main',
		);
	},
);

test('a closed space holds no path', async t => {
	const f = fixture(t, true);
	const opened = await f.open('STA-1');
	await f.state.daos.registry.remove('STA-1');
	t.deepEqual(f.state.daos.spaceIdentities.atPath(opened.worktreePath), {
		kind: 'unknown',
	});
});
