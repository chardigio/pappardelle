import test from 'ava';
import {JiraProvider} from './providers/jira-provider.ts';

// ============================================================================
// JiraProvider Unit Tests
// Note: Tests that call CLI commands (getIssue, createComment) are not tested
// here since they depend on `acli` being installed. We test the pure logic.
// ============================================================================

test('JiraProvider has name "jira"', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.name, 'jira');
});

test('buildIssueUrl uses base_url', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(
		provider.buildIssueUrl('PROJ-123'),
		'https://mycompany.atlassian.net/browse/PROJ-123',
	);
});

test('buildIssueUrl strips trailing slash from base_url', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net/');
	t.is(
		provider.buildIssueUrl('PROJ-456'),
		'https://mycompany.atlassian.net/browse/PROJ-456',
	);
});

test('getIssueCached returns null for uncached issues', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.getIssueCached('PROJ-999'), null);
});

test('getWorkflowStateColor returns null for unknown state', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.is(provider.getWorkflowStateColor('Unknown State'), null);
});

test('clearCache does not throw', t => {
	const provider = new JiraProvider('https://mycompany.atlassian.net');
	t.notThrows(() => provider.clearCache());
});
