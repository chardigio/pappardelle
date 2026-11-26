import React from 'react';
import {render} from '../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {until} from '../test/helpers/wait.ts';
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

test('renders before the scan finishes, then shows what it found', async () => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view} = await mount(store);
	teardown(async () => {
		await view.unmount();
	});

	expect(view.lastFrame()).toBe('(none)');

	scan.resolve([skill('alpha'), skill('beta')]);
	await until(
		async () => {
			await view.renderOnce();
			return view.lastFrame() !== '(none)';
		},
		() => view.lastFrame(),
	);
	expect(view.lastFrame()).toBe('alpha,beta');
});

test('a reopened prompt shows the last scan on its first frame, then the rescan', async () => {
	let next = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => next.promise);
	next.resolve([skill('alpha')]);
	await store.refresh(roots);

	next = deferred<SkillEntry[]>();
	const {view, renders} = await mount(store);
	teardown(async () => {
		await view.unmount();
	});

	expect(renders[0]).toBe('alpha');
	next.resolve([skill('alpha'), skill('installed-since')]);
	await until(
		async () => {
			await view.renderOnce();
			return view.lastFrame() !== 'alpha';
		},
		() => view.lastFrame(),
	);
	expect(view.lastFrame()).toBe('alpha,installed-since');
});

test('a scan that lands after unmount updates the store but not the dead view', async () => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view, renders} = await mount(store);
	await view.unmount();
	const rendersAtUnmount = renders.length;

	scan.resolve([skill('alpha')]);
	await until(() => store.current(roots) !== undefined);
	await delay(20);

	expect(store.current(roots)).toStrictEqual([skill('alpha')]);
	expect(renders.length).toBe(rendersAtUnmount);
});
