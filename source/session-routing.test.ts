import {test, expect} from 'bun:test';
import {
	routeSession,
	isPendingSessionResolved,
	buildNewSessionArgs,
	buildOpenWorkspaceArgs,
	extractIssueKeyFromIdowOutput,
	type PendingSession,
} from './session-routing.ts';

// ============================================================================
// Issue Key Routing
// ============================================================================

test('routeSession routes issue key as issue type', () => {
	const result = routeSession('STA-421');
	expect(result.type).toBe('issue');
	expect(result.issueKey).toBe('STA-421');
});

test('routeSession provides sentence-case pending title for issue routes', () => {
	const result = routeSession('STA-421');
	expect(result.pendingTitle).toBe('Opening\u2026');
});

test('routeSession preserves non-default team prefix', () => {
	const result = routeSession('ENG-100');
	expect(result.type).toBe('issue');
	expect(result.issueKey).toBe('ENG-100');
});

// ============================================================================
// Description Routing
// ============================================================================

test('routeSession routes null issue key as description', () => {
	const result = routeSession(null);
	expect(result.type).toBe('description');
	expect(result.issueKey).toBe(null);
});

test('routeSession provides sentence-case pending title for descriptions', () => {
	const result = routeSession(null);
	expect(result.pendingTitle).toBe('Starting new session\u2026');
});

// ============================================================================
// isPendingSessionResolved
// ============================================================================

test('resolves when issue key appears in spaces', () => {
	const pending: PendingSession = {
		type: 'issue',
		name: 'STA-464',
		idowArg: 'STA-464',
		pendingTitle: 'Opening\u2026',
		prevSpaceCount: 1,
	};
	expect(isPendingSessionResolved(pending, ['STA-463', 'STA-464'])).toBe(true);
});

test('does not resolve when issue key is absent from spaces', () => {
	const pending: PendingSession = {
		type: 'issue',
		name: 'STA-464',
		idowArg: 'STA-464',
		pendingTitle: 'Opening\u2026',
		prevSpaceCount: 1,
	};
	expect(isPendingSessionResolved(pending, ['STA-463'])).toBe(false);
});

test('resolves description session when space count increases', () => {
	const pending: PendingSession = {
		type: 'description',
		name: '',
		idowArg: 'add dark mode',
		pendingTitle: 'Starting new session\u2026',
		prevSpaceCount: 1,
	};
	expect(isPendingSessionResolved(pending, ['STA-463', 'STA-464'])).toBe(true);
});

test('does not resolve description session when count unchanged', () => {
	const pending: PendingSession = {
		type: 'description',
		name: '',
		idowArg: 'add dark mode',
		pendingTitle: 'Starting new session\u2026',
		prevSpaceCount: 1,
	};
	expect(isPendingSessionResolved(pending, ['STA-463'])).toBe(false);
});

// ============================================================================
// buildNewSessionArgs (idow should NOT open by default)
// ============================================================================

test('buildNewSessionArgs returns only the idow arg (no --open)', () => {
	const args = buildNewSessionArgs('STA-500', {inputIsIssueKey: false});
	expect(args).toStrictEqual(['STA-500']);
});

test('buildNewSessionArgs passes description as-is', () => {
	const args = buildNewSessionArgs('add dark mode to settings', {
		inputIsIssueKey: false,
	});
	expect(args).toStrictEqual(['add dark mode to settings']);
});

test('buildNewSessionArgs does not include --resume or --open', () => {
	const args = buildNewSessionArgs('STA-500', {inputIsIssueKey: false});
	expect(args.includes('--resume')).toBe(false);
	expect(args.includes('--open')).toBe(false);
});

// ============================================================================
// buildNewSessionArgs with a forced profile (STA-856: lock TUI choice in)
// ============================================================================

test('buildNewSessionArgs forwards --profile when profile name provided', () => {
	const args = buildNewSessionArgs('upload a personal image to trotbooks', {
		profileName: 'trotbooks',
		inputIsIssueKey: false,
	});
	expect(args).toStrictEqual([
		'--profile',
		'trotbooks',
		'upload a personal image to trotbooks',
	]);
});

test('buildNewSessionArgs omits --profile when profileName is null', () => {
	const args = buildNewSessionArgs('add dark mode', {
		profileName: null,
		inputIsIssueKey: false,
	});
	expect(args).toStrictEqual(['add dark mode']);
});

test('buildNewSessionArgs omits --profile when profileName is empty string', () => {
	const args = buildNewSessionArgs('add dark mode', {
		profileName: '',
		inputIsIssueKey: false,
	});
	expect(args).toStrictEqual(['add dark mode']);
});

test('buildNewSessionArgs puts --profile before the input so idow parses it', () => {
	// idow checks $1 for --profile; the flag must come before the input.
	const args = buildNewSessionArgs('STA-500', {
		profileName: 'pappardelle',
		inputIsIssueKey: false,
	});
	expect(args[0]).toBe('--profile');
	expect(args[1]).toBe('pappardelle');
	expect(args[2]).toBe('STA-500');
});

test('buildNewSessionArgs orders --agent-profile the way idow parses it', () => {
	const args = buildNewSessionArgs('STA-500', {
		profileName: 'pappardelle',
		agentProfileName: 'codex',
		inputIsIssueKey: true,
	});
	expect(args).toStrictEqual([
		'--profile',
		'pappardelle',
		'--agent-profile',
		'codex',
		'--issue-key',
		'STA-500',
	]);
});

// ============================================================================
// buildOpenWorkspaceArgs (pressing 'o' should open with --resume --open)
// ============================================================================

test('buildOpenWorkspaceArgs includes --resume and --open flags', () => {
	const args = buildOpenWorkspaceArgs('STA-500');
	expect(args.includes('--resume')).toBe(true);
	expect(args.includes('--open')).toBe(true);
});

test('buildOpenWorkspaceArgs passes issue key as last arg', () => {
	const args = buildOpenWorkspaceArgs('STA-500');
	expect(args.at(-1)).toBe('STA-500');
});

test('buildOpenWorkspaceArgs returns exact expected args', () => {
	const args = buildOpenWorkspaceArgs('ENG-42');
	expect(args).toStrictEqual(['--resume', '--open', '--issue-key', 'ENG-42']);
});

test('buildNewSessionArgs marks tracker-supplied keys as existing issues', () => {
	expect(
		buildNewSessionArgs('pappardelle-a1b2', {inputIsIssueKey: true}),
	).toStrictEqual(['--issue-key', 'pappardelle-a1b2']);
});

test('buildNewSessionArgs orders --profile ahead of --issue-key', () => {
	expect(
		buildNewSessionArgs('pappardelle-a1b2', {
			profileName: 'vendor',
			inputIsIssueKey: true,
		}),
	).toStrictEqual(['--profile', 'vendor', '--issue-key', 'pappardelle-a1b2']);
});

test('buildNewSessionArgs leaves typed input unflagged', () => {
	expect(
		buildNewSessionArgs('add dark mode', {inputIsIssueKey: false}),
	).toStrictEqual(['add dark mode']);
});

// ============================================================================
// extractIssueKeyFromIdowOutput
// ============================================================================

test('extracts issue key from idow success output', () => {
	const stdout = `
Starting workspace setup...

[ 1/13] Selecting project profile...
  ✓ Selected profile: Pappardelle
[ 4/13] Creating issue...
  ✓ Created issue: STA-633 (project will be assigned by Claude)
[ 8/13] Starting Claude tmux session...
  ✓ Claude session: claude-stardust-labs-STA-633

============================================
Workspace STA-633 is ready!
============================================

Issue:     https://linear.app/stardust-labs/issue/STA-633
`;
	expect(extractIssueKeyFromIdowOutput(stdout)).toBe('STA-633');
});

test('extracts issue key with non-STA prefix', () => {
	const stdout = 'Workspace ENG-42 is ready!\n';
	expect(extractIssueKeyFromIdowOutput(stdout)).toBe('ENG-42');
});

// beads mints lowercase prefixes with an alphanumeric suffix rather than the
// uppercase/numeric shape Linear and Jira use. Failing to match these left the
// space unregistered and hung the TUI's pending row with no error.
test('extracts beads-shaped issue key', () => {
	expect(
		extractIssueKeyFromIdowOutput('Workspace pappardelle-osc is ready!\n'),
	).toBe('pappardelle-osc');
	expect(
		extractIssueKeyFromIdowOutput('Workspace myproj-a1b2 is ready!\n'),
	).toBe('myproj-a1b2');
});

// A beads prefix defaults to the repo directory name, so it can carry hyphens
// and underscores of its own. Stopping at the first hyphen truncated the key
// and left the pending row waiting on a space that never arrived.
test('extracts beads key whose prefix contains hyphens or underscores', () => {
	expect(
		extractIssueKeyFromIdowOutput('Workspace vendor-sdk-a1b2 is ready!\n'),
	).toBe('vendor-sdk-a1b2');
	expect(
		extractIssueKeyFromIdowOutput('Workspace my_service-a1b2 is ready!\n'),
	).toBe('my_service-a1b2');
});

test('extracts a hierarchical beads child key', () => {
	expect(
		extractIssueKeyFromIdowOutput('Workspace vendor-sdk-a1b2.1 is ready!\n'),
	).toBe('vendor-sdk-a1b2.1');
});

test('extracts beads key wrapped in ANSI color codes', () => {
	const stdout = '[0;32mWorkspace pappardelle-osc is ready![0m\n';
	expect(extractIssueKeyFromIdowOutput(stdout)).toBe('pappardelle-osc');
});

test('uses the final summary instead of ready messages quoted in the input', () => {
	const inputLog =
		'[2026-10-12 15:00:00] [startup] Input: fix the misleading Workspace STE-1 is ready! message\n';
	expect(extractIssueKeyFromIdowOutput(inputLog)).toBe(null);
	expect(
		extractIssueKeyFromIdowOutput(
			inputLog +
				'Workspace STE-2 is ready!\n' +
				'\u001b[0;32mWorkspace STE-99 is ready!\u001b[0m\n',
		),
	).toBe('STE-99');
});

test('returns null when idow output has no workspace line', () => {
	expect(extractIssueKeyFromIdowOutput('')).toBe(null);
	expect(extractIssueKeyFromIdowOutput('some random output')).toBe(null);
	expect(extractIssueKeyFromIdowOutput('Error: something failed')).toBe(null);
});

test('returns null for partial workspace line', () => {
	expect(extractIssueKeyFromIdowOutput('Workspace is ready')).toBe(null);
	expect(extractIssueKeyFromIdowOutput('Workspace STA- is ready')).toBe(null);
});
