import fs from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {testState} from '../test/helpers/state.ts';
import {
	createIssueTracker,
	createVcsHost,
	recordIssueTitles,
	resetProviders,
	setIssueTitles,
	setStateColors,
	setWorkspaceDiscovery,
	type IssueTrackerConfig,
	type TrackerIssue,
} from './providers/index.ts';
import {claimIssue} from './tracker.ts';

// Tests must be serial because they share singleton state
test.beforeEach(() => {
	resetProviders();
});

// ============================================================================
// Factory: Issue Tracker
// ============================================================================

test.serial('createIssueTracker defaults to LinearProvider', t => {
	const provider = createIssueTracker();
	t.is(provider.name, 'linear');
});

test.serial(
	'createIssueTracker returns LinearProvider for explicit linear config',
	t => {
		const provider = createIssueTracker({provider: 'linear'});
		t.is(provider.name, 'linear');
	},
);

test.serial(
	'createIssueTracker returns JiraProvider for jira config with base_url',
	t => {
		const provider = createIssueTracker({
			provider: 'jira',
			base_url: 'https://mycompany.atlassian.net',
		});
		t.is(provider.name, 'jira');
	},
);

test.serial('createIssueTracker returns BeadsProvider for beads config', t => {
	const provider = createIssueTracker({provider: 'beads'});
	t.is(provider.name, 'beads');
});

test.serial('createIssueTracker needs no base_url for beads', t => {
	// Beads is local — there is no host to point at.
	t.notThrows(() => createIssueTracker({provider: 'beads'}));
});

test.serial(
	'createIssueTracker throws when re-initialized from beads to jira',
	t => {
		createIssueTracker({provider: 'beads'});
		t.throws(
			() =>
				createIssueTracker({
					provider: 'jira',
					base_url: 'https://example.com',
				}),
			{message: /already initialized as "beads"/},
		);
	},
);

test.serial(
	'createIssueTracker with no config returns existing Beads singleton',
	t => {
		const beads = createIssueTracker({provider: 'beads'});
		t.is(createIssueTracker(), beads);
	},
);

test.serial('createIssueTracker throws for jira without base_url', t => {
	t.throws(() => createIssueTracker({provider: 'jira'}), {
		message: /base_url is required/,
	});
});

test.serial('createIssueTracker throws for unknown provider', t => {
	t.throws(
		// @ts-expect-error testing invalid input
		() => createIssueTracker({provider: 'unknown'}),
		{message: /Unknown issue tracker provider/},
	);
});

test.serial('createIssueTracker returns singleton', t => {
	const a = createIssueTracker();
	const b = createIssueTracker();
	t.is(a, b);
});

// ============================================================================
// Factory: VCS Host
// ============================================================================

test.serial('createVcsHost defaults to GitHubProvider', t => {
	const provider = createVcsHost();
	t.is(provider.name, 'github');
});

test.serial(
	'createVcsHost returns GitHubProvider for explicit github config',
	t => {
		const provider = createVcsHost({provider: 'github'});
		t.is(provider.name, 'github');
	},
);

test.serial('createVcsHost returns GitLabProvider for gitlab config', t => {
	const provider = createVcsHost({provider: 'gitlab'});
	t.is(provider.name, 'gitlab');
});

test.serial('createVcsHost throws for unknown provider', t => {
	t.throws(
		// @ts-expect-error testing invalid input
		() => createVcsHost({provider: 'unknown'}),
		{message: /Unknown VCS host provider/},
	);
});

test.serial('createVcsHost returns singleton', t => {
	const a = createVcsHost();
	const b = createVcsHost();
	t.is(a, b);
});

// ============================================================================
// No-config returns existing singleton (regardless of provider type)
// ============================================================================

test.serial(
	'createIssueTracker with no config returns existing Jira singleton',
	t => {
		const jira = createIssueTracker({
			provider: 'jira',
			base_url: 'https://example.com',
		});
		const noConfig = createIssueTracker();
		t.is(noConfig, jira);
		t.is(noConfig.name, 'jira');
	},
);

test.serial(
	'createVcsHost with no config returns existing GitLab singleton',
	t => {
		const gitlab = createVcsHost({
			provider: 'gitlab',
			host: 'gitlab.example.com',
		});
		const noConfig = createVcsHost();
		t.is(noConfig, gitlab);
		t.is(noConfig.name, 'gitlab');
	},
);

// ============================================================================
// Config mismatch detection
// ============================================================================

test.serial(
	'createIssueTracker throws when called with different config than cached',
	t => {
		createIssueTracker(); // defaults to linear
		t.throws(
			() =>
				createIssueTracker({
					provider: 'jira',
					base_url: 'https://example.com',
				}),
			{message: /already initialized/},
		);
	},
);

test.serial(
	'createVcsHost throws when called with different config than cached',
	t => {
		createVcsHost(); // defaults to github
		t.throws(() => createVcsHost({provider: 'gitlab'}), {
			message: /already initialized/,
		});
	},
);

test.serial('createIssueTracker allows same config on subsequent calls', t => {
	const a = createIssueTracker({provider: 'linear'});
	const b = createIssueTracker({provider: 'linear'});
	t.is(a, b);
});

// The rail follows a branch recorded by link-pr only through the discovery
// that startup hands over, whichever host the config then selects.
for (const provider of ['github', 'gitlab'] as const) {
	test.serial(
		`the ${provider} host finds workspace repositories with the discovery set at startup`,
		async t => {
			const asked: string[] = [];
			setWorkspaceDiscovery(async directory => {
				asked.push(directory);
				return [];
			});
			await createVcsHost({provider}).getBulkRailStatus(
				['KEY-1'],
				new Map([['KEY-1', '/workspace']]),
			);
			t.deepEqual(asked, ['/workspace']);
		},
	);
}

// A tracker knows the color of a state no open issue is in only from the
// colors kept between runs, which startup hands over the same way.
for (const config of [
	{provider: 'linear'},
	{provider: 'jira', base_url: 'https://example.com'},
	{provider: 'beads'},
] satisfies IssueTrackerConfig[]) {
	test.serial(
		`the ${config.provider} tracker loads the state colors set at startup`,
		t => {
			setStateColors({
				load: () => ({'Stored State': '#123456'}),
				async set() {},
			});
			t.is(
				createIssueTracker(config).getWorkflowStateColor('Stored State'),
				'#123456',
			);
		},
	);
}

// ============================================================================
// Issue titles
// ============================================================================

const issue = (title: string): TrackerIssue => ({
	identifier: 'STA-1',
	title,
	state: {name: 'Todo', type: 'unstarted', color: '#000000'},
});

// The rail reads every space's issue on each refresh, so an unchanged title
// must not rewrite the space's state.
test.serial(
	'a title read from the tracker is stored when it changed, and a failed read stores nothing',
	async t => {
		let now = 0;
		const {spaceState} = testState(t, {clock: () => new Date(now)}).daos;
		setIssueTitles(spaceState);

		await recordIssueTitles([
			['STA-1', issue('First')],
			['STA-2', null],
		]);
		const first = spaceState.read('STA-1');
		t.is(first?.issueTitle, 'First');
		t.is(spaceState.read('STA-2'), null);

		now = 1000;
		await recordIssueTitles([['STA-1', issue('First')]]);
		await recordIssueTitles([['STA-1', null]]);
		t.deepEqual(spaceState.read('STA-1'), first);

		await recordIssueTitles([['STA-1', issue('Renamed')]]);
		t.like(spaceState.read('STA-1'), {
			issueTitle: 'Renamed',
			updatedAt: new Date(1000).toISOString(),
		});
	},
);

test.serial(
	'a title is not written over a state file that cannot be read',
	async t => {
		const {spaceState} = testState(t, {sqlite: false}).daos;
		setIssueTitles(spaceState);
		const file = spaceState.file('STA-1');
		fs.mkdirSync(path.dirname(file), {recursive: true});
		const halfWritten = '{"profile": "dev", "prLinks": [';
		fs.writeFileSync(file, halfWritten);

		await recordIssueTitles([['STA-1', issue('First')]]);

		t.is(fs.readFileSync(file, 'utf8'), halfWritten);
	},
);

// ============================================================================
// resetProviders
// ============================================================================

test.serial('resetProviders clears cached singletons', t => {
	const a = createIssueTracker();
	resetProviders();
	const b = createIssueTracker();
	t.not(a, b);
	t.is(a.name, b.name);
});

test.serial(
	'resetProviders allows re-initialization with different config',
	t => {
		createIssueTracker(); // linear
		resetProviders();
		const b = createIssueTracker({
			provider: 'jira',
			base_url: 'https://example.com',
		});
		t.is(b.name, 'jira');
	},
);

// ============================================================================
// claimIssue capability
// ============================================================================

test.serial('only beads advertises claimIssue', t => {
	// Regression: an unconditional `bd update --claim` at the call site fired
	// for Linear and Jira keys too, handing a remote tracker's key to a local
	// database. Capability lives on the provider so the call site cannot guess.
	t.truthy(createIssueTracker({provider: 'beads'}).claimIssue);

	resetProviders();
	t.falsy(createIssueTracker({provider: 'linear'}).claimIssue);

	resetProviders();
	t.falsy(
		createIssueTracker({provider: 'jira', base_url: 'https://example.com'})
			.claimIssue,
	);
});

test.serial(
	'claimIssue facade resolves false for a tracker without it',
	async t => {
		createIssueTracker({provider: 'linear'});
		t.false(await claimIssue('STA-1234'));
	},
);
