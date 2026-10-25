import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	getActiveSpaceCount,
	calculateIdealListHeight,
	calculateLayout,
} from './tmux.ts';
import {setRegistryPath, resetRegistryPath} from './space-registry.ts';

let tempCounter = 0;
function tempRegistryPath(): string {
	return path.join(
		os.tmpdir(),
		`pappardelle-space-count-test-${process.pid}-${Date.now()}-${tempCounter++}.json`,
	);
}

test.afterEach(() => {
	resetRegistryPath();
});

// ============================================================================
// getActiveSpaceCount uses the space registry (not tmux sessions)
// ============================================================================

test.serial('returns 0 when registry is empty', t => {
	setRegistryPath(tempRegistryPath());
	t.is(getActiveSpaceCount(), 0);
});

test.serial('returns count of registered spaces', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200', 'STA-300']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 3);
});

test.serial('returns 1 for a single registered space', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 1);
});

test.serial('returns 0 when registry file does not exist', t => {
	setRegistryPath(path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`));
	t.is(getActiveSpaceCount(), 0);
});

test.serial('returns correct count after registry file changes', t => {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(['STA-100', 'STA-200']));
	setRegistryPath(p);
	t.is(getActiveSpaceCount(), 2);
});

// ============================================================================
// List-pane sizing accounts for the always-pinned main-worktree row that
// app.tsx prepends above the user's registered spaces. Without the +1
// adjustment the bottom row is clipped on narrow screens (the symptom
// reported by users with N>=1 worktrees).
// ============================================================================

function seedRegistry(spaces: string[]): void {
	const p = tempRegistryPath();
	fs.mkdirSync(path.dirname(p), {recursive: true});
	fs.writeFileSync(p, JSON.stringify(spaces));
	setRegistryPath(p);
}

test.serial(
	'calculateIdealListHeight: 0 registered spaces → height fits 1 row (main only)',
	t => {
		seedRegistry([]);
		// 0 registered + 1 main = 1 visible row → ideal height 1+2 = 3
		t.is(calculateIdealListHeight(), 3);
	},
);

test.serial(
	'calculateIdealListHeight: 1 registered space → height fits 2 rows (main + 1)',
	t => {
		seedRegistry(['STA-100']);
		// 1 registered + 1 main = 2 visible rows → ideal height 2+2 = 4
		t.is(calculateIdealListHeight(), 4);
	},
);

test.serial(
	'calculateIdealListHeight: 2 registered spaces → height fits 3 rows (main + 2)',
	t => {
		seedRegistry(['STA-100', 'STA-200']);
		// 2 registered + 1 main = 3 visible rows → ideal height 3+2 = 5
		// Without the main-worktree adjustment this returned 4 and clipped the
		// bottom row on narrow/mobile layouts — that was the bug.
		t.is(calculateIdealListHeight(), 5);
	},
);

test.serial(
	'calculateIdealListHeight: 5 registered spaces → height fits 6 rows (main + 5)',
	t => {
		seedRegistry(['STA-1', 'STA-2', 'STA-3', 'STA-4', 'STA-5']);
		// 5 registered + 1 main = 6 visible rows → ideal height 6+2 = 8
		t.is(calculateIdealListHeight(), 8);
	},
);

test.serial(
	'calculateLayout vertical: 2 registered spaces → list pane fits 3 rows on narrow screens',
	t => {
		seedRegistry(['STA-100', 'STA-200']);
		// Narrow screen (40 cols), 30 rows tall — typical mobile terminal.
		// 2 registered + 1 main = 3 visible rows → listHeight = 5 (3 + 2 chrome).
		// The 25% proportional cap allows up to floor(29 * 0.25) = 7 rows here,
		// so the ideal height drives the result.
		const layout = calculateLayout(40, 30);
		t.is(layout.direction, 'vertical');
		t.is(layout.listHeight, 5);
	},
);

test.serial(
	'calculateLayout vertical: 0 registered spaces → list pane still fits the main row',
	t => {
		seedRegistry([]);
		// 0 registered + 1 main = 1 visible row → listHeight = 3 (1 + 2 chrome)
		const layout = calculateLayout(40, 30);
		t.is(layout.direction, 'vertical');
		t.is(layout.listHeight, 3);
	},
);
