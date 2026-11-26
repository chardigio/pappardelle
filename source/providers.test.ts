import fs from 'node:fs';
import path from 'node:path';
import {test, expect, beforeEach} from 'bun:test';
import {testState} from '../test/helpers/state.ts';
import {trackerIssue} from '../test/helpers/space-fixtures.ts';
import {
	createIssueTracker,
	createVcsHost,
	recordIssueTitles,
	resetProviders,
	setIssueTitles,
	setStateColors,
	setWorkspaceDiscovery,
	type IssueTrackerConfig,
	type TrackerProviderName,
	type VcsProviderName,
} from './providers/index.ts';
import {claimIssue} from './tracker.ts';

// Tests must be serial because they share singleton state
beforeEach(() => {
	resetProviders();
});

// ============================================================================
// Factory: Issue Tracker
// ============================================================================

test('createIssueTracker defaults to LinearProvider', () => {
	const provider = createIssueTracker();
	expect(provider.name).toBe('linear');
});

test('createIssueTracker returns LinearProvider for explicit linear config', () => {
	const provider = createIssueTracker({provider: 'linear'});
	expect(provider.name).toBe('linear');
});

test('createIssueTracker returns JiraProvider for jira config with base_url', () => {
	const provider = createIssueTracker({
		provider: 'jira',
		base_url: 'https://mycompany.atlassian.net',
	});
	expect(provider.name).toBe('jira');
});

test('createIssueTracker returns BeadsProvider for beads config', () => {
	const provider = createIssueTracker({provider: 'beads'});
	expect(provider.name).toBe('beads');
});

test('createIssueTracker needs no base_url for beads', () => {
	// Beads is local — there is no host to point at.
	expect(() => createIssueTracker({provider: 'beads'})).not.toThrow();
});

test('createIssueTracker throws when re-initialized from beads to jira', () => {
	createIssueTracker({provider: 'beads'});
	expect(() =>
		createIssueTracker({
			provider: 'jira',
			base_url: 'https://example.com',
		}),
	).toThrow(/already initialized as "beads"/);
});

test('createIssueTracker with no config returns existing Beads singleton', () => {
	const beads = createIssueTracker({provider: 'beads'});
	expect(createIssueTracker()).toBe(beads);
});

test('createIssueTracker throws for jira without base_url', () => {
	expect(() => createIssueTracker({provider: 'jira'})).toThrow(
		/base_url is required/,
	);
});

// Config validation rejects an unknown provider name; this test and the
// createVcsHost one below cover the factories' throw for a name that got
// past it.
test('createIssueTracker throws for unknown provider', () => {
	const provider = 'unknown' as unknown as TrackerProviderName;
	expect(() => createIssueTracker({provider})).toThrow(
		/Unknown issue tracker provider/,
	);
});

test('createIssueTracker returns singleton', () => {
	const a = createIssueTracker();
	const b = createIssueTracker();
	expect(a).toBe(b);
});

// ============================================================================
// Factory: VCS Host
// ============================================================================

test('createVcsHost defaults to GitHubProvider', () => {
	const provider = createVcsHost();
	expect(provider.name).toBe('github');
});

test('createVcsHost returns GitHubProvider for explicit github config', () => {
	const provider = createVcsHost({provider: 'github'});
	expect(provider.name).toBe('github');
});

test('createVcsHost returns GitLabProvider for gitlab config', () => {
	const provider = createVcsHost({provider: 'gitlab'});
	expect(provider.name).toBe('gitlab');
});

test('createVcsHost throws for unknown provider', () => {
	const provider = 'unknown' as unknown as VcsProviderName;
	expect(() => createVcsHost({provider})).toThrow(/Unknown VCS host provider/);
});

test('createVcsHost returns singleton', () => {
	const a = createVcsHost();
	const b = createVcsHost();
	expect(a).toBe(b);
});

// ============================================================================
// No-config returns existing singleton (regardless of provider type)
// ============================================================================

test('createIssueTracker with no config returns existing Jira singleton', () => {
	const jira = createIssueTracker({
		provider: 'jira',
		base_url: 'https://example.com',
	});
	const noConfig = createIssueTracker();
	expect(noConfig).toBe(jira);
	expect(noConfig.name).toBe('jira');
});

test('createVcsHost with no config returns existing GitLab singleton', () => {
	const gitlab = createVcsHost({
		provider: 'gitlab',
		host: 'gitlab.example.com',
	});
	const noConfig = createVcsHost();
	expect(noConfig).toBe(gitlab);
	expect(noConfig.name).toBe('gitlab');
});

// ============================================================================
// Config mismatch detection
// ============================================================================

test('createIssueTracker throws when called with different config than cached', () => {
	createIssueTracker(); // defaults to linear
	expect(() =>
		createIssueTracker({
			provider: 'jira',
			base_url: 'https://example.com',
		}),
	).toThrow(/already initialized/);
});

test('createVcsHost throws when called with different config than cached', () => {
	createVcsHost(); // defaults to github
	expect(() => createVcsHost({provider: 'gitlab'})).toThrow(
		/already initialized/,
	);
});

test('createIssueTracker allows same config on subsequent calls', () => {
	const a = createIssueTracker({provider: 'linear'});
	const b = createIssueTracker({provider: 'linear'});
	expect(a).toBe(b);
});

// The rail follows a branch recorded by link-pr only through the discovery
// that startup hands over, whichever host the config then selects.
for (const provider of ['github', 'gitlab'] as const) {
	test(`the ${provider} host finds workspace repositories with the discovery set at startup`, async () => {
		const asked: string[] = [];
		setWorkspaceDiscovery(async directory => {
			asked.push(directory);
			return [];
		});
		await createVcsHost({provider}).getBulkRailStatus(
			['KEY-1'],
			new Map([['KEY-1', '/workspace']]),
		);
		expect(asked).toStrictEqual(['/workspace']);
	});
}

// A tracker knows the color of a state no open issue is in only from the
// colors kept between runs, which startup hands over the same way.
for (const config of [
	{provider: 'linear'},
	{provider: 'jira', base_url: 'https://example.com'},
	{provider: 'beads'},
] satisfies IssueTrackerConfig[]) {
	test(`the ${config.provider} tracker loads the state colors set at startup`, () => {
		setStateColors({
			load: () => ({'Stored State': '#123456'}),
			async set() {},
		});
		expect(
			createIssueTracker(config).getWorkflowStateColor('Stored State'),
		).toBe('#123456');
	});
}

// ============================================================================
// Issue titles
// ============================================================================

// The rail reads every space's issue on each refresh, so an unchanged title
// must not rewrite the space's state.
test('a title read from the tracker is stored when it changed, and a failed read stores nothing', async () => {
	let now = 0;
	const {spaceState} = testState({clock: () => new Date(now)}).daos;
	setIssueTitles(spaceState);

	await recordIssueTitles([
		['STA-1', trackerIssue({title: 'First'})],
		['STA-2', null],
	]);
	const first = spaceState.read('STA-1');
	expect(first?.issueTitle).toBe('First');
	expect(spaceState.read('STA-2')).toBe(null);

	now = 1000;
	await recordIssueTitles([['STA-1', trackerIssue({title: 'First'})]]);
	await recordIssueTitles([['STA-1', null]]);
	expect(spaceState.read('STA-1')).toStrictEqual(first);

	await recordIssueTitles([['STA-1', trackerIssue({title: 'Renamed'})]]);
	expect(spaceState.read('STA-1')).toMatchObject({
		issueTitle: 'Renamed',
		updatedAt: new Date(1000).toISOString(),
	});
});

test('a title is not written over a state file that cannot be read', async () => {
	const {spaceState} = testState({sqlite: false}).daos;
	setIssueTitles(spaceState);
	const file = spaceState.file('STA-1');
	fs.mkdirSync(path.dirname(file), {recursive: true});
	const halfWritten = '{"profile": "dev", "prLinks": [';
	fs.writeFileSync(file, halfWritten);

	await recordIssueTitles([['STA-1', trackerIssue({title: 'First'})]]);

	expect(fs.readFileSync(file, 'utf8')).toBe(halfWritten);
});

// ============================================================================
// resetProviders
// ============================================================================

test('resetProviders clears cached singletons', () => {
	const a = createIssueTracker();
	resetProviders();
	const b = createIssueTracker();
	expect(a).not.toBe(b);
	expect(a.name).toBe(b.name);
});

test('resetProviders allows re-initialization with different config', () => {
	createIssueTracker(); // linear
	resetProviders();
	const b = createIssueTracker({
		provider: 'jira',
		base_url: 'https://example.com',
	});
	expect(b.name).toBe('jira');
});

// ============================================================================
// claimIssue capability
// ============================================================================

test('only beads advertises claimIssue', () => {
	// Regression: an unconditional `bd update --claim` at the call site fired
	// for Linear and Jira keys too, handing a remote tracker's key to a local
	// database. Capability lives on the provider so the call site cannot guess.
	expect(createIssueTracker({provider: 'beads'}).claimIssue).toBeTruthy();

	resetProviders();
	expect(createIssueTracker({provider: 'linear'}).claimIssue).toBeFalsy();

	resetProviders();
	expect(
		createIssueTracker({provider: 'jira', base_url: 'https://example.com'})
			.claimIssue,
	).toBeFalsy();
});

test('claimIssue facade resolves false for a tracker without it', async () => {
	createIssueTracker({provider: 'linear'});
	expect(await claimIssue('STA-1234')).toBe(false);
});
