import test from 'ava';
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

test('stripSkinTones removes every Fitzpatrick modifier and keeps other text', t => {
	t.is(stripSkinTones('Ship 👍🏻 👍🏼 👍🏽 👍🏾 👍🏿 now'), 'Ship 👍 👍 👍 👍 👍 now');
	t.is(stripSkinTones('👩🏽‍🍳 cooks'), '👩‍🍳 cooks');
	t.is(stripSkinTones('Plain ✨ ⚙️ 👨‍🍳 title'), 'Plain ✨ ⚙️ 👨‍🍳 title');
	t.is(stripSkinTones('no emoji here'), 'no emoji here');
});

test.serial('only a bare 3.6 draws skin-tone modifiers wide', async t => {
	await withTmux(async () => {
		t.true(await drawsWide('3.6'));
	});
	for (const version of ['3.5', '3.6a', '3.6b', '3.7c', '3.8', 'next-3.9']) {
		await withTmux(async () => {
			t.false(await drawsWide(version), `version ${version}`);
		});
	}
});

test.serial('an unreadable version inside tmux does not strip', async t => {
	await withTmux(async () => {
		t.false(await drawsWide(null));
		t.is(maybeStripSkinTones('💪🏼', tmuxDrawsSkinToneWide()), '💪🏼');
	});
});

test.serial('outside tmux the version is never probed', async t => {
	await withTmux(async () => {
		let calls = 0;
		setTmuxVersionProbeForTests(async () => {
			calls++;
			return '3.6';
		});
		await resolveTmuxSkinTone();
		t.false(tmuxDrawsSkinToneWide());
		t.is(calls, 0);
	}, false);
});

test.serial(
	'a stalled probe leaves the modifiers in place until the version is known',
	async t => {
		await withTmux(async () => {
			let finish!: (version: string) => void;
			let calls = 0;
			setTmuxVersionProbeForTests(async () => {
				calls++;
				return new Promise(resolve => {
					finish = resolve;
				});
			});
			t.false(tmuxDrawsSkinToneWide());
			t.is(calls, 0, 'reading the flag must not start a probe');
			const resolved = resolveTmuxSkinTone();
			t.false(tmuxDrawsSkinToneWide());
			finish('3.6');
			await resolved;
			t.true(tmuxDrawsSkinToneWide());
		});
	},
);

test('maybeStripSkinTones strips only when told tmux mis-draws them', t => {
	t.is(maybeStripSkinTones('💪🏼', true), '💪');
	t.is(maybeStripSkinTones('Ship 👍🏽 fixes', true), 'Ship 👍 fixes');
	t.is(maybeStripSkinTones(undefined, true), undefined);
	t.is(maybeStripSkinTones('💪🏼', false), '💪🏼');
});

test.serial('the version query runs once per process', async t => {
	await withTmux(async () => {
		let calls = 0;
		setTmuxVersionProbeForTests(async () => {
			calls++;
			return '3.6';
		});
		await Promise.all([resolveTmuxSkinTone(), resolveTmuxSkinTone()]);
		await resolveTmuxSkinTone();
		t.is(calls, 1);
	});
});
