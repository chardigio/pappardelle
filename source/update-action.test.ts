import test from 'ava';
import {
	resolveUpdateKeyAction,
	buildUpdateConfirmContent,
} from './update-action.ts';
import type {UpdateInfo} from './update-check.ts';

// ============================================================================
// resolveUpdateKeyAction
// ============================================================================

test('STA-1548: U opens the confirm dialog even when no banner is visible', t => {
	// The whole point of the feature: the 24h update-check cache may be stale, so
	// a release that landed minutes ago wouldn't have surfaced a banner yet. U
	// must still be a live "update to latest" request.
	t.is(resolveUpdateKeyAction('U', false), 'open-confirm');
	t.is(resolveUpdateKeyAction('u', false), 'open-confirm');
});

test('U opens the confirm dialog when the banner IS visible too (unified path)', t => {
	t.is(resolveUpdateKeyAction('U', true), 'open-confirm');
	t.is(resolveUpdateKeyAction('u', true), 'open-confirm');
});

test('X dismisses the banner only while it is visible', t => {
	t.is(resolveUpdateKeyAction('X', true), 'dismiss-banner');
	t.is(resolveUpdateKeyAction('x', true), 'dismiss-banner');
});

test('X is a no-op when no banner is visible (nothing to dismiss)', t => {
	t.is(resolveUpdateKeyAction('X', false), 'none');
	t.is(resolveUpdateKeyAction('x', false), 'none');
});

test('unrelated keys are a no-op regardless of banner visibility', t => {
	for (const k of ['q', 'n', 'j', 'k', '?', 'g', 'i', 'd', 'o', 'p', 'e', '']) {
		t.is(resolveUpdateKeyAction(k, true), 'none', `key ${JSON.stringify(k)}`);
		t.is(resolveUpdateKeyAction(k, false), 'none', `key ${JSON.stringify(k)}`);
	}
});

// ============================================================================
// buildUpdateConfirmContent
// ============================================================================

test('confirm content shows installed→latest when an update was detected', t => {
	const info: UpdateInfo = {
		installedVersion: 'v0.1.0',
		latestVersion: 'v0.2.0',
	};
	const c = buildUpdateConfirmContent(info, 'v0.1.0');
	t.is(c.message, 'Update from v0.1.0 to v0.2.0?');
});

test('confirm content normalizes a missing v-prefix to a single v', t => {
	const info: UpdateInfo = {installedVersion: '0.1.0', latestVersion: '0.2.0'};
	const c = buildUpdateConfirmContent(info, '0.1.0');
	t.is(c.message, 'Update from v0.1.0 to v0.2.0?');
});

test('confirm content falls back to the current version when no banner info', t => {
	// The always-available U press with a fresh-enough cache: we have no live
	// "latest" to show, but we still know what we're running.
	const c = buildUpdateConfirmContent(null, 'v0.7.9');
	t.is(c.message, 'Update to the latest release? (currently on v0.7.9)');
});

test('confirm content degrades gracefully when nothing is known', t => {
	const c = buildUpdateConfirmContent(null, null);
	t.is(c.message, 'Update to the latest release?');
});

test('confirm content always carries a non-empty title and detail', t => {
	const info: UpdateInfo = {
		installedVersion: 'v1.0.0',
		latestVersion: 'v2.0.0',
	};
	for (const c of [
		buildUpdateConfirmContent(info, 'v1.0.0'),
		buildUpdateConfirmContent(null, 'v1.0.0'),
		buildUpdateConfirmContent(null, null),
	]) {
		t.truthy(c.title);
		t.truthy(c.detail);
	}
});
