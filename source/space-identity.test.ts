import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {rejectionOf} from '../test/helpers/thrown.ts';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {testState, type TestState} from '../test/helpers/state.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';
import {
	newSpaceIdentity,
	protectedSessionNames,
	worktreePathFor,
	type SpaceIdentity,
} from './space-identity.ts';
import {stateDbPath} from './state-db.ts';

const SOCKET = 'identity-test-socket';

/** Stores with a home of their own, and the identities idow would give its spaces. */
function fixture(sqlite?: boolean, repo?: string) {
	const home = tempDir('papp-identity-');
	const mainRoot = path.join(home, 'workspace', 'repo');
	fs.mkdirSync(path.join(mainRoot, 'src'), {recursive: true});
	const state = testState({
		sqlite,
		...(repo === undefined ? {} : {repo}),
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

function contractFixture(state: TestState) {
	return fixture(state.sqlite);
}

contractTest(
	'a space is found under the names it was opened with',
	async state => {
		const f = contractFixture(state);
		for (const key of ['a.b_c', 'bd-a3f8e9.1', 'main']) {
			const opened = await f.open(key);
			expect(f.state.daos.spaceIdentities.get(key)).toStrictEqual({
				kind: 'identity',
				identity: opened,
			});
		}

		expect(f.identity('a.b_c').tmux.agentSession).toBe('agent-repo-a_b__c');
	},
);

contractTest('main is listed with the open spaces', async state => {
	const f = contractFixture(state);
	await f.open('main');
	await f.open('STA-1');
	const listed = f.state.daos.spaceIdentities.list();
	expect(listed.kind).toBe('identities');
	if (listed.kind !== 'identities') return;
	expect(listed.identities.map(identity => identity.key).sort()).toStrictEqual([
		'STA-1',
		'main',
	]);
});

contractTest(
	'a path is in the space whose worktree holds it, through a symlink too',
	async state => {
		const f = contractFixture(state);
		await f.open('main');
		const opened = await f.open('STA-1');
		const deep = path.join(opened.worktreePath, 'packages', 'app');
		fs.mkdirSync(deep, {recursive: true});
		const link = path.join(f.home, 'link');
		fs.symlinkSync(path.join(opened.worktreePath, 'packages'), link);
		const {spaceIdentities} = f.state.daos;

		expect(spaceIdentities.atPath(deep)).toStrictEqual({
			kind: 'identity',
			identity: opened,
		});
		expect(spaceIdentities.atPath(path.join(link, 'app'))).toStrictEqual({
			kind: 'identity',
			identity: opened,
		});
		expect(
			(
				spaceIdentities.atPath(path.join(f.mainRoot, 'src')) as {
					identity: SpaceIdentity;
				}
			).identity.key,
		).toBe('main');
		expect(spaceIdentities.atPath(f.home)).toStrictEqual({kind: 'unknown'});
	},
);

test('a key never opened has no identity', () => {
	const f = fixture(true);
	expect(f.state.daos.spaceIdentities.get('STA-9')).toStrictEqual({
		kind: 'unknown',
	});
});

test('a closed space keeps its identity', async () => {
	const f = fixture(true);
	await f.open('main');
	const opened = await f.open('STA-1');
	await f.state.daos.registry.remove('STA-1');
	expect(f.state.daos.spaceIdentities.get('STA-1')).toStrictEqual({
		kind: 'identity',
		identity: opened,
	});
	const listed = f.state.daos.spaceIdentities.list();
	expect(
		listed.kind === 'identities' &&
			listed.identities.map(identity => identity.key),
	).toStrictEqual(['main', 'STA-1']);
});

test('a space whose worktree is not where idow puts them is found where it is', async () => {
	const f = fixture(true);
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
	expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	expect(f.state.daos.spaceIdentities.get('STA-1')).toStrictEqual({
		kind: 'identity',
		identity: {...f.identity('STA-1'), worktreePath: custom},
	});
	expect(f.state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'identity',
		identity: f.identity('main'),
	});
});

test('a space opened without the database is given the identity idow gave it, along with main', () => {
	const f = fixture(true);
	fs.writeFileSync(f.state.registryFile, JSON.stringify(['STA-1']));
	expect(f.state.daos.spaceIdentities.get('STA-1')).toStrictEqual({
		kind: 'identity',
		identity: f.identity('STA-1'),
	});
	expect(f.state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'identity',
		identity: f.identity('main'),
	});
});

contractTest(
	'a checkout with no Pappardelle config or stored identity belongs to no space',
	state => {
		const f = contractFixture(state);
		expect(
			f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')),
		).toStrictEqual({kind: 'unknown'});
	},
);

contractTest(
	'a repo with .pappardelle.yml resolves main even before any spaces are opened',
	state => {
		const f = contractFixture(state);
		fs.writeFileSync(path.join(f.mainRoot, '.pappardelle.yml'), 'version: 1\n');
		expect(f.state.daos.spaceIdentities.get('main')).toStrictEqual({
			kind: 'identity',
			identity: f.identity('main'),
		});
		expect(
			f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')),
		).toStrictEqual({kind: 'identity', identity: f.identity('main')});
	},
);

test('importing another repo from an unrelated checkout does not seed main with the wrong path', () => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-identity-cross-')),
	);
	teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const otherRepo = path.join(home, 'workspace', 'other-repo');
	fs.mkdirSync(otherRepo, {recursive: true});
	fs.writeFileSync(path.join(otherRepo, '.pappardelle.yml'), 'version: 1\n');
	const state = testState({
		repo: 'target-repo',
		sqlite: true,
		home,
		env: {PAPPARDELLE_TMUX_SOCKET: SOCKET},
		mainRoot: () => otherRepo,
	});
	fs.writeFileSync(state.registryFile, JSON.stringify(['STA-1']));
	expect(state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'unknown',
	});
});

test('importing open-spaces outside a git checkout still seeds main on a later read inside it', () => {
	const home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'papp-identity-retry-')),
	);
	teardown(() => {
		fs.rmSync(home, {recursive: true, force: true});
	});
	const mainRoot = path.join(home, 'workspace', 'repo');
	fs.mkdirSync(mainRoot, {recursive: true});
	let inCheckout = false;
	const state = testState({
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
	expect(state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'unknown',
	});
	inCheckout = true;
	const lookup = state.daos.spaceIdentities.get('main');
	expect(lookup.kind).toBe('identity');
	if (lookup.kind === 'identity') {
		expect(lookup.identity.worktreePath).toBe(mainRoot);
	}
});

test('two keys cannot share an agent session', async () => {
	const f = fixture(true);
	await f.open('a.b');
	const other = f.identity('other');
	const clash = {
		...other,
		tmux: {...other.tmux, agentSession: f.identity('a.b').tmux.agentSession},
	};
	expect(
		await rejectionOf(f.state.daos.spaceIdentities.record(clash)),
	).toHaveProperty('message', expect.stringMatching(/UNIQUE/));
});

test('the reaper keeps the stored names of main and every protected space', async () => {
	const f = fixture(true);
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
	expect(
		owned.kind === 'names' ? [...owned.names].sort() : owned,
	).toStrictEqual([
		'agent-repo-main',
		'companion-repo-main',
		'hand-named-agent',
		'hand-named-companion',
	]);
});

test('a protected space without stored names stops the reap', async () => {
	const f = fixture(true);
	await f.open('main');
	await f.state.daos.registry.add('STA-1');
	expect(
		protectedSessionNames(f.state.daos.registry, f.state.daos.spaceIdentities),
	).toStrictEqual({kind: 'missing', keys: ['STA-1']});
});

test('identities that cannot be read stop the reap', () => {
	const f = fixture(true);
	const error = new Error('locked');
	expect(
		protectedSessionNames(f.state.daos.registry, {
			list: () => ({kind: 'unreadable', error}),
		}),
	).toStrictEqual({kind: 'unreadable', error});
});

test('a space keeps the names it was first given', async () => {
	const f = fixture(true);
	const first = await f.open('STA-1');
	await f.state.daos.spaceIdentities.record({
		...first,
		worktreePath: '/elsewhere',
		tmux: {...first.tmux, socket: 'another-socket'},
	});
	expect(f.state.daos.spaceIdentities.get('STA-1')).toStrictEqual({
		kind: 'identity',
		identity: first,
	});
});

test('stored session names that tmux would expand as a format are respelled, and others are left as they are', async () => {
	const f = fixture(true, 'pasta#S');
	const recorded = await f.open('STA-1');
	const formatSpelled = {
		...f.identity('STA-2'),
		tmux: {
			...recorded.tmux,
			agentSession: 'agent-pasta#S-STA-2',
			companionSession: 'companion-pasta#S-STA-2',
		},
	};
	await f.state.daos.spaceIdentities.record(formatSpelled);

	await f.state.daos.spaceIdentities.respellFormatSessions();

	expect(f.state.daos.spaceIdentities.get('STA-1')).toStrictEqual({
		kind: 'identity',
		identity: recorded,
	});
	expect(f.state.daos.spaceIdentities.get('STA-2')).toStrictEqual({
		kind: 'identity',
		identity: {
			...formatSpelled,
			tmux: {
				...formatSpelled.tmux,
				agentSession: 'agent-pasta_S-STA-2',
				companionSession: 'companion-pasta_S-STA-2',
			},
		},
	});
});

test("a respelled name another repo's space already holds is left as it is, and the other names are still respelled", async () => {
	const f = fixture(true, 'pasta#S');
	const held = await f.open('STA-1');
	await f.state.daos.spaceIdentities.record({
		...held,
		repo: 'pasta_S',
		tmux: {
			...held.tmux,
			agentSession: 'agent-pasta_S-STA-3',
			companionSession: 'companion-pasta_S-STA-3',
		},
		key: 'STA-3',
	});
	const formatSpelled = (key: string) => ({
		...f.identity(key),
		tmux: {
			...held.tmux,
			agentSession: `agent-pasta#S-${key}`,
			companionSession: `companion-pasta#S-${key}`,
		},
	});
	await f.state.daos.spaceIdentities.record(formatSpelled('STA-3'));
	await f.state.daos.spaceIdentities.record(formatSpelled('STA-4'));

	await f.state.daos.spaceIdentities.respellFormatSessions();

	expect(f.state.daos.spaceIdentities.get('STA-3')).toStrictEqual({
		kind: 'identity',
		identity: formatSpelled('STA-3'),
	});
	expect(f.state.daos.spaceIdentities.get('STA-4')).toMatchObject({
		identity: {tmux: {agentSession: 'agent-pasta_S-STA-4'}},
	});
});

test('main follows its checkout when a TUI starts there, not when a space is opened', async () => {
	const f = fixture(true);
	const first = await f.open('main');
	const moved = {
		...first,
		worktreePath: '/moved/repo',
		tmux: {...first.tmux, socket: 'another-socket'},
	};
	await f.state.daos.spaceIdentities.record(moved);
	expect(f.state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'identity',
		identity: first,
	});
	await f.state.daos.spaceIdentities.moveMain(moved);
	expect(f.state.daos.spaceIdentities.get('main')).toStrictEqual({
		kind: 'identity',
		identity: moved,
	});
});

contractTest(
	'a path in a checkout nested in a worktree belongs to no space',
	async state => {
		const f = contractFixture(state);
		await f.open('main');
		const nested = path.join(f.mainRoot, '.claude', 'worktrees', 'agent-x');
		fs.mkdirSync(path.join(nested, 'src'), {recursive: true});
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: elsewhere\n');
		expect(
			f.state.daos.spaceIdentities.atPath(path.join(nested, 'src')),
		).toStrictEqual({
			kind: 'unknown',
		});
		expect(
			(
				f.state.daos.spaceIdentities.atPath(path.join(f.mainRoot, 'src')) as {
					identity: SpaceIdentity;
				}
			).identity.key,
		).toBe('main');
	},
);

test('a closed space holds no path', async () => {
	const f = fixture(true);
	const opened = await f.open('STA-1');
	await f.state.daos.registry.remove('STA-1');
	expect(
		f.state.daos.spaceIdentities.atPath(opened.worktreePath),
	).toStrictEqual({
		kind: 'unknown',
	});
});
