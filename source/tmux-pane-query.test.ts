/**
 * Regression for the sidebar's "rows render nothing but the emoji" bug.
 *
 * `tmux display-message -p '#{pane_width}'` resolves against the *active* pane,
 * not the calling process's pane. pappardelle lives in a sidebar the user
 * normally isn't focused on, so the untargeted query reported the (much wider)
 * claude pane. The list then laid its rows out for a width the pane didn't
 * have, and Yoga's shrink chewed the issue key and title off every row.
 */
import test from 'ava';
import {paneQueryArgs} from './tmux.ts';

test('a pane id is passed through as an explicit -t target', t => {
	t.deepEqual(paneQueryArgs('#{pane_width}', '%7'), [
		'display-message',
		'-p',
		'-t',
		'%7',
		'#{pane_width}',
	]);
});

test('the target precedes the format string (tmux rejects the other order)', t => {
	const args = paneQueryArgs('#{pane_height}', '%12');
	t.true(args.indexOf('-t') < args.indexOf('#{pane_height}'));
	t.is(args.at(-1), '#{pane_height}');
});

test('without a pane id the query falls back to the untargeted form', t => {
	// Outside tmux $TMUX_PANE is unset; the spawn fails and the caller's
	// fallback dimension is used, so the untargeted form is harmless here.
	t.deepEqual(paneQueryArgs('#{pane_width}', undefined), [
		'display-message',
		'-p',
		'#{pane_width}',
	]);
	t.deepEqual(paneQueryArgs('#{pane_width}', ''), [
		'display-message',
		'-p',
		'#{pane_width}',
	]);
});
