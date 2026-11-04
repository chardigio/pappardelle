import React from 'react';
import {render} from '../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {
	createSkillSnapshot,
	type SkillEntry,
	type SkillSnapshot,
} from './skill-completion.ts';
import {useSkillSnapshot} from './use-skill-snapshot.ts';

const roots = {repoRoot: '/repo', homeDir: '/home'};

function skill(name: string): SkillEntry {
	return {name, description: '', source: 'repo', kind: 'skill'};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(_resolve => {
		resolve = _resolve;
	});
	return {promise, resolve};
}

async function mount(store: SkillSnapshot) {
	const renders: string[] = [];
	function View() {
		const skills = useSkillSnapshot(store, roots);
		const text = skills.map(entry => entry.name).join(',') || '(none)';
		renders.push(text);
		return React.createElement('text', {}, text);
	}

	const view = await render(React.createElement(View));
	return {view, renders};
}

async function waitFor(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 3000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('Timed out');
		await delay(5);
	}
}

test('renders before the scan finishes, then shows what it found', async t => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view} = await mount(store);
	t.teardown(async () => {
		await view.unmount();
	});

	t.is(view.lastFrame(), '(none)');

	scan.resolve([skill('alpha'), skill('beta')]);
	await waitFor(async () => {
		await view.renderOnce();
		return view.lastFrame() !== '(none)';
	});
	t.is(view.lastFrame(), 'alpha,beta');
});

test('a reopened prompt shows the last scan on its first frame, then the rescan', async t => {
	let next = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => next.promise);
	next.resolve([skill('alpha')]);
	await store.refresh(roots);

	next = deferred<SkillEntry[]>();
	const {view, renders} = await mount(store);
	t.teardown(async () => {
		await view.unmount();
	});

	t.is(renders[0], 'alpha');
	next.resolve([skill('alpha'), skill('installed-since')]);
	await waitFor(async () => {
		await view.renderOnce();
		return view.lastFrame() !== 'alpha';
	});
	t.is(view.lastFrame(), 'alpha,installed-since');
});

test('a scan that lands after unmount updates the store but not the dead view', async t => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view, renders} = await mount(store);
	await view.unmount();
	const rendersAtUnmount = renders.length;

	scan.resolve([skill('alpha')]);
	await waitFor(() => store.current(roots) !== undefined);
	await delay(20);

	t.deepEqual(store.current(roots), [skill('alpha')]);
	t.is(renders.length, rendersAtUnmount);
});
