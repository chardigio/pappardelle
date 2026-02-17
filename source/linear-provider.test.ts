import test from 'ava';
import {LinearProvider} from './providers/linear-provider.ts';

// ============================================================================
// LinearProvider Unit Tests
// Note: Tests that call CLI commands (getIssue, createComment) are not tested
// here since they depend on `linctl` being installed. We test the pure logic.
// ============================================================================

test('LinearProvider has name "linear"', t => {
	const provider = new LinearProvider();
	t.is(provider.name, 'linear');
});

test('getIssueCached returns null for uncached issues', t => {
	const provider = new LinearProvider();
	t.is(provider.getIssueCached('STA-999'), null);
});

test('buildIssueUrl constructs Linear URL', t => {
	const provider = new LinearProvider();
	t.is(
		provider.buildIssueUrl('STA-123'),
		'https://linear.app/stardust-labs/issue/STA-123',
	);
});

// ============================================================================
// getWorkflowStateColor: must be cache-only (no subprocess calls)
// LinearProvider.getWorkflowStateColor was previously shelling out to `linctl`
// synchronously. This caused React "setState during render" warnings because
// the subprocess failure triggered log.warn → error listener → setState in App.
// The fix: getWorkflowStateColor should only check the in-memory cache.
// ============================================================================

test('getWorkflowStateColor returns null for uncached state (no subprocess)', t => {
	const provider = new LinearProvider();
	// This should return null immediately without shelling out to linctl.
	// If it shelled out, it would throw/hang in CI where linctl isn't installed.
	const color = provider.getWorkflowStateColor('In Progress');
	t.is(color, null);
});

test('getWorkflowStateColor returns null for "Done" when not cached', t => {
	const provider = new LinearProvider();
	const color = provider.getWorkflowStateColor('Done');
	t.is(color, null);
});

test('clearCache does not throw', t => {
	const provider = new LinearProvider();
	t.notThrows(() => provider.clearCache());
});
