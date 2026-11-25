import {test, expect} from 'bun:test';
import {stripSkinTones} from './emoji-rail-width.ts';
import {
	maybeStripSkinTones,
	resolveTmuxSkinTone,
	setTmuxVersionProbeForTests,
	tmuxDrawsSkinToneWide,
} from './tmux-skin-tone.ts';

async function withTmux(
	fn: () => Promise<void> | void,
	insideTmux = true,
): Promise<void> {
	const previous = process.env['TMUX'];
	if (insideTmux) process.env['TMUX'] = '/tmp/fake-socket,1,0';
	else delete process.env['TMUX'];
	try {
		await fn();
	} finally {
		if (previous === undefined) delete process.env['TMUX'];
		else process.env['TMUX'] = previous;
		setTmuxVersionProbeForTests(null);
	}
}

async function drawsWide(version: string | null): Promise<boolean> {
	setTmuxVersionProbeForTests(async () => version);
	await resolveTmuxSkinTone();
	return tmuxDrawsSkinToneWide();
}

test('stripSkinTones removes every Fitzpatrick modifier and keeps other text', () => {
	expect(stripSkinTones('Ship 👍🏻 👍🏼 👍🏽 👍🏾 👍🏿 now')).toBe(
		'Ship 👍 👍 👍 👍 👍 now',
	);
	expect(stripSkinTones('👩🏽‍🍳 cooks')).toBe('👩‍🍳 cooks');
	expect(stripSkinTones('Plain ✨ ⚙️ 👨‍🍳 title')).toBe('Plain ✨ ⚙️ 👨‍🍳 title');
	expect(stripSkinTones('no emoji here')).toBe('no emoji here');
});

test('only a bare 3.6 draws skin-tone modifiers wide', async () => {
	await withTmux(async () => {
		expect(await drawsWide('3.6')).toBe(true);
	});
	for (const version of ['3.5', '3.6a', '3.6b', '3.7c', '3.8', 'next-3.9']) {
		await withTmux(async () => {
			expect(await drawsWide(version), `version ${version}`).toBe(false);
		});
	}
});

test('an unreadable version inside tmux does not strip', async () => {
	await withTmux(async () => {
		expect(await drawsWide(null)).toBe(false);
		expect(maybeStripSkinTones('💪🏼', tmuxDrawsSkinToneWide())).toBe('💪🏼');
	});
});

test('outside tmux the version is never probed', async () => {
	await withTmux(async () => {
		let calls = 0;
		setTmuxVersionProbeForTests(async () => {
			calls++;
			return '3.6';
		});
		await resolveTmuxSkinTone();
		expect(tmuxDrawsSkinToneWide()).toBe(false);
		expect(calls).toBe(0);
	}, false);
});

test('a stalled probe leaves the modifiers in place until the version is known', async () => {
	await withTmux(async () => {
		let finish!: (version: string) => void;
		let calls = 0;
		setTmuxVersionProbeForTests(async () => {
			calls++;
			return new Promise(resolve => {
				finish = resolve;
			});
		});
		expect(tmuxDrawsSkinToneWide()).toBe(false);
		expect(calls, 'reading the flag must not start a probe').toBe(0);
		const resolved = resolveTmuxSkinTone();
		expect(tmuxDrawsSkinToneWide()).toBe(false);
		finish('3.6');
		await resolved;
		expect(tmuxDrawsSkinToneWide()).toBe(true);
	});
});

test('maybeStripSkinTones strips only when told tmux mis-draws them', () => {
	expect(maybeStripSkinTones('💪🏼', true)).toBe('💪');
	expect(maybeStripSkinTones('Ship 👍🏽 fixes', true)).toBe('Ship 👍 fixes');
	expect(maybeStripSkinTones(undefined, true)).toBe(undefined);
	expect(maybeStripSkinTones('💪🏼', false)).toBe('💪🏼');
});

test('the version query runs once per process', async () => {
	await withTmux(async () => {
		let calls = 0;
		setTmuxVersionProbeForTests(async () => {
			calls++;
			return '3.6';
		});
		await Promise.all([resolveTmuxSkinTone(), resolveTmuxSkinTone()]);
		await resolveTmuxSkinTone();
		expect(calls).toBe(1);
	});
});
