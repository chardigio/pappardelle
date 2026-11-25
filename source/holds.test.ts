import fs from 'node:fs';
import {test, expect} from 'bun:test';
import {contractTest} from '../test/helpers/dao-contract.ts';
import {holdsDir, holdFor, type Hold, type HeldPrompt} from './holds.ts';

const prompt: HeldPrompt = {
	key: 'STA-1',
	tool: 'Bash command',
	command: 'doctl account get',
	filePath: null,
	cwd: '/home/u/.worktrees/repo/STA-1',
	approvable: true,
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

contractTest('a hold is stored, listed and changed', async state => {
	const store = state.daos.holds;
	await store.save(hold());
	await store.save(hold({id: 'h2', createdAt: '2026-11-22T11:00:00.000Z'}));
	expect(store.list().map(stored => stored.id)).toStrictEqual(['h1', 'h2']);

	await store.save(
		hold({state: 'approved', resolvedAt: '2026-11-22T10:05:00.000Z'}),
	);
	expect(store.load('h1')?.state).toBe('approved');
	expect(store.load('nope')).toBe(null);
});

contractTest(
	'a hold approved by a process without the database is read from its file',
	async state => {
		const store = state.daos.holds;
		await store.save(hold());
		const file = `${holdsDir(state.repo, state.stateDir)}/h1.json`;
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Hold;
		fs.writeFileSync(file, JSON.stringify({...written, state: 'approved'}));
		expect(store.load('h1')?.state).toBe('approved');
	},
);

test('a retry of an open hold reuses it rather than stacking another', () => {
	expect(holdFor([hold()], prompt, 'open')?.id).toBe('h1');
	expect(holdFor([hold({state: 'dismissed'})], prompt, 'open')).toBe(null);
});

test('an approved hold matches only the same prompt from the same space', () => {
	const approved = [hold({state: 'approved'})];
	expect(holdFor(approved, prompt, 'approved')?.id).toBe('h1');
	for (const other of [
		{key: 'STA-2'},
		{tool: 'Edit file'},
		{command: 'doctl apps list'},
		{filePath: '/x'},
		{cwd: '/tmp'},
	]) {
		expect(holdFor(approved, {...prompt, ...other}, 'approved')).toBe(null);
	}

	expect(holdFor([hold({state: 'used'})], prompt, 'approved')).toBe(null);
	expect(holdFor([hold()], prompt, 'approved')).toBe(null);
});
