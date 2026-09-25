import test from 'ava';
import {stripSkinTones} from './emoji-rail-width.ts';
import {
	maybeStripSkinTones,
	setTmuxVersionProbeForTests,
	tmuxDrawsSkinToneWide,
} from './tmux-skin-tone.ts';

function withTmux(
	fn: (setProbe: (version: string | null) => void) => void,
): void {
	const previous = process.env['TMUX'];
	process.env['TMUX'] = '/tmp/fake-socket,1,0';
	let probeFn: () => string | null = () => null;
	const setProbe = (version: string | null): void => {
		probeFn = () => version;
		setTmuxVersionProbeForTests(probeFn);
	};
	fn(setProbe);
	if (previous === undefined) {
		delete process.env['TMUX'];
	} else {
		process.env['TMUX'] = previous;
	}
	setTmuxVersionProbeForTests(null);
}

test('stripSkinTones removes every Fitzpatrick modifier and keeps other text', t => {
	t.is(stripSkinTones('Ship 👍🏻 👍🏼 👍🏽 👍🏾 👍🏿 now'), 'Ship 👍 👍 👍 👍 👍 now');
	t.is(stripSkinTones('👩🏽‍🍳 cooks'), '👩‍🍳 cooks');
	t.is(stripSkinTones('Plain ✨ ⚙️ 👨‍🍳 title'), 'Plain ✨ ⚙️ 👨‍🍳 title');
	t.is(stripSkinTones('no emoji here'), 'no emoji here');
});

test('only a bare 3.6 draws skin-tone modifiers wide', t => {
	withTmux(setProbe => {
		setProbe('3.6');
		t.true(tmuxDrawsSkinToneWide());
	});
	for (const version of ['3.5', '3.6a', '3.6b', '3.7c', '3.8', 'next-3.9']) {
		withTmux(setProbe => {
			setProbe(version);
			t.false(tmuxDrawsSkinToneWide(), `version ${version}`);
		});
	}
});

test('an unreadable version inside tmux does not strip', t => {
	withTmux(setProbe => {
		setProbe(null);
		t.false(tmuxDrawsSkinToneWide());
		t.is(maybeStripSkinTones('💪🏼'), '💪🏼');
	});
});

test('outside tmux the modifiers are never stripped', t => {
	const previous = process.env['TMUX'];
	delete process.env['TMUX'];
	try {
		setTmuxVersionProbeForTests(() => '3.6');
		t.false(tmuxDrawsSkinToneWide());
		t.is(maybeStripSkinTones('💪🏼'), '💪🏼');
	} finally {
		if (previous !== undefined) {
			process.env['TMUX'] = previous;
		}
		setTmuxVersionProbeForTests(null);
	}
});

test('maybeStripSkinTones strips only on the broken release and passes undefined through', t => {
	withTmux(setProbe => {
		setProbe('3.6');
		t.is(maybeStripSkinTones('💪🏼'), '💪');
		t.is(maybeStripSkinTones('Ship 👍🏽 fixes'), 'Ship 👍 fixes');
		t.is(maybeStripSkinTones(undefined), undefined);
	});
	withTmux(setProbe => {
		setProbe('3.6a');
		t.is(maybeStripSkinTones('💪🏼'), '💪🏼');
	});
});

test('the version query runs once per process', t => {
	let calls = 0;
	withTmux(setProbe => {
		setTmuxVersionProbeForTests(() => {
			calls += 1;
			return '3.6';
		});
		t.true(tmuxDrawsSkinToneWide());
		t.true(tmuxDrawsSkinToneWide());
		t.is(calls, 1);
	});
});
