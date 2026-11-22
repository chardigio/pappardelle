import fs from 'node:fs';
import test from 'ava';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {
	approvedHoldFor,
	holdsDir,
	openHoldFor,
	type Hold,
	type HeldPrompt,
} from './holds.ts';

const prompt: HeldPrompt = {
	key: 'STA-1',
	tool: 'Bash command',
	command: 'doctl account get',
	filePath: null,
	cwd: '/home/u/.worktrees/repo/STA-1',
};

const hold = (fields: Partial<Hold> = {}): Hold => ({
	...prompt,
	id: 'h1',
	reason: 'doctl deploys or reaches a cloud account',
	state: 'open',
	createdAt: '2026-11-22T10:00:00.000Z',
	resolvedAt: null,
	...fields,
});

contractTest('a hold is stored, listed and changed', async (t, state) => {
	const store = state.daos.holds;
	await store.save(hold());
	await store.save(hold({id: 'h2', createdAt: '2026-11-22T11:00:00.000Z'}));
	t.deepEqual(
		store.list().map(stored => stored.id),
		['h1', 'h2'],
	);

	await store.save(
		hold({state: 'approved', resolvedAt: '2026-11-22T10:05:00.000Z'}),
	);
	t.is(store.load('h1')?.state, 'approved');
	t.is(store.load('nope'), null);
});

contractTest(
	'a hold approved by a process without the database is read from its file',
	async (t, state) => {
		const store = state.daos.holds;
		await store.save(hold());
		const file = `${holdsDir(state.repo, state.stateDir)}/h1.json`;
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Hold;
		fs.writeFileSync(file, JSON.stringify({...written, state: 'approved'}));
		t.is(store.load('h1')?.state, 'approved');
	},
);

test('a retry of an open hold reuses it rather than stacking another', t => {
	t.is(openHoldFor([hold()], prompt)?.id, 'h1');
	t.is(openHoldFor([hold({state: 'dismissed'})], prompt), null);
});

test('an approved hold matches only the same prompt from the same space', t => {
	const approved = [hold({state: 'approved'})];
	t.is(approvedHoldFor(approved, prompt)?.id, 'h1');
	for (const other of [
		{key: 'STA-2'},
		{tool: 'Edit file'},
		{command: 'doctl apps list'},
		{filePath: '/x'},
		{cwd: '/tmp'},
	]) {
		t.is(approvedHoldFor(approved, {...prompt, ...other}), null);
	}

	t.is(approvedHoldFor([hold({state: 'used'})], prompt), null);
	t.is(approvedHoldFor([hold()], prompt), null);
});
