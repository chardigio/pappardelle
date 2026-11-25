import {test, expect} from 'bun:test';
import {
	resolveUpdateKeyAction,
	buildUpdateConfirmContent,
} from './update-action.ts';
import type {UpdateInfo} from './update-check.ts';

// ============================================================================
// resolveUpdateKeyAction
// ============================================================================

test('STA-1548: U opens the confirm dialog even when no banner is visible', () => {
	// The whole point of the feature: the 24h update-check cache may be stale, so
	// a release that landed minutes ago wouldn't have surfaced a banner yet. U
	// must still be a live "update to latest" request.
	expect(resolveUpdateKeyAction('U', false)).toBe('open-confirm');
	expect(resolveUpdateKeyAction('u', false)).toBe('open-confirm');
});

test('U opens the confirm dialog when the banner IS visible too (unified path)', () => {
	expect(resolveUpdateKeyAction('U', true)).toBe('open-confirm');
	expect(resolveUpdateKeyAction('u', true)).toBe('open-confirm');
});

test('X dismisses the banner only while it is visible', () => {
	expect(resolveUpdateKeyAction('X', true)).toBe('dismiss-banner');
	expect(resolveUpdateKeyAction('x', true)).toBe('dismiss-banner');
});

test('X is a no-op when no banner is visible (nothing to dismiss)', () => {
	expect(resolveUpdateKeyAction('X', false)).toBe('none');
	expect(resolveUpdateKeyAction('x', false)).toBe('none');
});

test('unrelated keys are a no-op regardless of banner visibility', () => {
	for (const k of ['q', 'n', 'j', 'k', '?', 'g', 'i', 'd', 'o', 'p', 'e', '']) {
		expect(resolveUpdateKeyAction(k, true), `key ${JSON.stringify(k)}`).toBe(
			'none',
		);
		expect(resolveUpdateKeyAction(k, false), `key ${JSON.stringify(k)}`).toBe(
			'none',
		);
	}
});

// ============================================================================
// buildUpdateConfirmContent
// ============================================================================

test('confirm content shows installed→latest when an update was detected', () => {
	const info: UpdateInfo = {
		installedVersion: 'v0.1.0',
		latestVersion: 'v0.2.0',
	};
	const c = buildUpdateConfirmContent(info, 'v0.1.0');
	expect(c.message).toBe('Update from v0.1.0 to v0.2.0?');
});

test('confirm content normalizes a missing v-prefix to a single v', () => {
	const info: UpdateInfo = {installedVersion: '0.1.0', latestVersion: '0.2.0'};
	const c = buildUpdateConfirmContent(info, '0.1.0');
	expect(c.message).toBe('Update from v0.1.0 to v0.2.0?');
});

test('confirm content falls back to the current version when no banner info', () => {
	// The always-available U press with a fresh-enough cache: we have no live
	// "latest" to show, but we still know what we're running.
	const c = buildUpdateConfirmContent(null, 'v0.7.9');
	expect(c.message).toBe('Update to the latest release? (currently on v0.7.9)');
});

test('confirm content degrades gracefully when nothing is known', () => {
	const c = buildUpdateConfirmContent(null, null);
	expect(c.message).toBe('Update to the latest release?');
});

test('confirm content always carries a non-empty title and detail', () => {
	const info: UpdateInfo = {
		installedVersion: 'v1.0.0',
		latestVersion: 'v2.0.0',
	};
	for (const c of [
		buildUpdateConfirmContent(info, 'v1.0.0'),
		buildUpdateConfirmContent(null, 'v1.0.0'),
		buildUpdateConfirmContent(null, null),
	]) {
		expect(c.title).toBeTruthy();
		expect(c.detail).toBeTruthy();
	}
});
