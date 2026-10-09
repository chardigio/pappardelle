import React from 'react';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
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

function mount(store: SkillSnapshot) {
	const renders: string[] = [];
	function View() {
		const skills = useSkillSnapshot(store, roots);
		const text = skills.map(entry => entry.name).join(',') || '(none)';
		renders.push(text);
		return React.createElement(Text, {}, text);
	}

	const view = render(React.createElement(View));
	return {view, renders};
}

async function waitFor(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('Timed out');
		await delay(5);
	}
}

test('renders before the scan finishes, then shows what it found', async t => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view} = mount(store);
	t.teardown(() => view.unmount());

	t.is(view.lastFrame(), '(none)');

	scan.resolve([skill('alpha'), skill('beta')]);
	await waitFor(() => view.lastFrame() === 'alpha,beta');
	t.pass();
});

test('a reopened prompt shows the last scan on its first frame, then the rescan', async t => {
	let next = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => next.promise);
	next.resolve([skill('alpha')]);
	await store.refresh(roots);

	next = deferred<SkillEntry[]>();
	const {view, renders} = mount(store);
	t.teardown(() => view.unmount());

	t.is(renders[0], 'alpha');
	next.resolve([skill('alpha'), skill('installed-since')]);
	await waitFor(() => view.lastFrame() === 'alpha,installed-since');
	t.pass();
});

test('a scan that lands after unmount updates the store but not the dead view', async t => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const {view, renders} = mount(store);
	view.unmount();
	const rendersAtUnmount = renders.length;

	scan.resolve([skill('alpha')]);
	await waitFor(() => store.current(roots) !== undefined);
	await delay(20);

	t.deepEqual(store.current(roots), [skill('alpha')]);
	t.is(renders.length, rendersAtUnmount);
});
