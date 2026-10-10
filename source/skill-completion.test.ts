import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	applySkillCompletion,
	clampSelection,
	createSkillSnapshot,
	discoverSkills,
	reanchorSelection,
	handleSkillListKey,
	handleSkillPickerKey,
	matchSkills,
	skillQuery,
	skillTokenLength,
	SKILL_PICKER_MAX_VISIBLE,
	type SkillEntry,
} from './skill-completion.ts';

// ============================================================================
// Test helpers
// ============================================================================

let tmpCounter = 0;

function makeTmpDir(): string {
	return fs.mkdtempSync(
		path.join(
			os.tmpdir(),
			`pappardelle-skill-test-${process.pid}-${tmpCounter++}-`,
		),
	);
}

function writeSkill(
	root: string,
	name: string,
	description: string | null,
): void {
	const dir = path.join(root, '.claude', 'skills', name);
	fs.mkdirSync(dir, {recursive: true});
	const frontmatter =
		description === null
			? `---\nname: ${name}\n---\n`
			: `---\nname: ${name}\ndescription: ${description}\n---\n`;
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}\nBody text.\n`);
}

function writeCommand(
	root: string,
	relative: string,
	description: string | null,
): void {
	const file = path.join(root, '.claude', 'commands', `${relative}.md`);
	fs.mkdirSync(path.dirname(file), {recursive: true});
	const frontmatter =
		description === null ? '' : `---\ndescription: ${description}\n---\n`;
	fs.writeFileSync(file, `${frontmatter}Do the thing.\n`);
}

function entry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name,
		description: '',
		source: 'repo',
		kind: 'skill',
		...overrides,
	};
}

// ============================================================================
// skillQuery: when is the completion list open at all?
// ============================================================================

test('skillQuery returns the token after a leading slash', t => {
	t.is(skillQuery('/do-pap'), 'do-pap');
});

test('skillQuery returns an empty query for a bare slash', t => {
	t.is(skillQuery('/'), '');
});

test('skillQuery returns null when the text does not start with a slash', t => {
	t.is(skillQuery('fix the login bug'), null);
	t.is(skillQuery('STA-123'), null);
	t.is(skillQuery(''), null);
});

test('skillQuery returns null once the first token is finished', t => {
	t.is(skillQuery('/do-pappardelle make the rail wider'), null);
	t.is(skillQuery('/do-pappardelle '), null);
});

test('skillQuery ignores a slash that is not the first character', t => {
	t.is(skillQuery(' /do-pap'), null);
	t.is(skillQuery('fix /do-pap'), null);
});

// ============================================================================
// Backwards compatibility: no slash means byte-identical behavior
// ============================================================================

test('regression: ordinary prompts never open the completion list', t => {
	const prompts = [
		'STA-123',
		'123',
		'https://linear.app/stardust-labs/issue/STA-123/thing',
		'add a button to the settings screen',
		'ios! fix the crash',
		'',
		'   ',
	];
	for (const prompt of prompts) {
		t.is(skillQuery(prompt), null, `prompt: ${prompt}`);
	}
});

// ============================================================================
// matchSkills: ranking
// ============================================================================

test('matchSkills returns every entry for an empty query', t => {
	const entries = [entry('do-stardust'), entry('do-pappardelle')];
	t.deepEqual(
		matchSkills(entries, '').map(m => m.name),
		['do-stardust', 'do-pappardelle'],
	);
});

test('matchSkills ranks prefix matches above substring matches', t => {
	const entries = [entry('run-pappardelle'), entry('pappardelle-init')];
	t.deepEqual(
		matchSkills(entries, 'pap').map(m => m.name),
		['pappardelle-init', 'run-pappardelle'],
	);
});

test('matchSkills is case-insensitive', t => {
	const entries = [entry('do-pappardelle')];
	t.deepEqual(
		matchSkills(entries, 'DO-PAP').map(m => m.name),
		['do-pappardelle'],
	);
});

test('matchSkills drops entries that do not match', t => {
	const entries = [entry('do-pappardelle'), entry('publish-hive-beta')];
	t.deepEqual(
		matchSkills(entries, 'hive').map(m => m.name),
		['publish-hive-beta'],
	);
});

test('matchSkills ranks repo entries above user entries within a tier', t => {
	const entries = [
		entry('papa-user', {source: 'user'}),
		entry('papa-repo', {source: 'repo'}),
	];
	t.deepEqual(
		matchSkills(entries, 'papa').map(m => m.name),
		['papa-repo', 'papa-user'],
	);
});

test('matchSkills ranks plugin entries below user entries within a tier', t => {
	const entries = [
		entry('papa:plugin', {source: 'plugin'}),
		entry('papa-user', {source: 'user'}),
	];
	t.deepEqual(
		matchSkills(entries, 'papa').map(m => m.name),
		['papa-user', 'papa:plugin'],
	);
});

test('matchSkills does not match against descriptions', t => {
	const entries = [entry('publish-hive-beta', {description: 'pappardelle'})];
	t.deepEqual(matchSkills(entries, 'pappardelle'), []);
});

// ============================================================================
// applySkillCompletion
// ============================================================================

test('applySkillCompletion replaces the token and adds a trailing space', t => {
	t.is(applySkillCompletion('do-pappardelle'), '/do-pappardelle ');
});

// ============================================================================
// skillTokenLength: the prompt paints a leading skill name in its own color
// ============================================================================

const PAINT_ENTRIES = [
	entry('do-pappardelle'),
	entry('do-platform'),
	entry('db:reset', {kind: 'command'}),
];

test('skillTokenLength measures a completed name followed by a description', t => {
	t.is(
		skillTokenLength('/do-pappardelle fix the picker', PAINT_ENTRIES),
		'/do-pappardelle'.length,
	);
});

test('skillTokenLength measures a name that is the whole prompt', t => {
	t.is(skillTokenLength('/do-platform', PAINT_ENTRIES), '/do-platform'.length);
});

test('skillTokenLength leaves a half-typed name unpainted', t => {
	t.is(skillTokenLength('/do-pap', PAINT_ENTRIES), 0);
});

test('skillTokenLength leaves a name nobody has installed unpainted', t => {
	t.is(skillTokenLength('/not-a-real-skill run it', PAINT_ENTRIES), 0);
});

test('skillTokenLength paints a nested command in its colon form', t => {
	t.is(skillTokenLength('/db:reset now', PAINT_ENTRIES), '/db:reset'.length);
});

test('skillTokenLength ignores a prompt that does not begin with a slash', t => {
	t.is(skillTokenLength('do-pappardelle', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('add a backend endpoint', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('STA-123', PAINT_ENTRIES), 0);
	t.is(skillTokenLength('', PAINT_ENTRIES), 0);
});

test('skillTokenLength matches the name exactly, not a prefix of it', t => {
	// `/do-plat` is a prefix of an installed name but is not itself installed.
	t.is(skillTokenLength('/do-plat form', PAINT_ENTRIES), 0);
});

// ============================================================================
// handleSkillPickerKey
// ============================================================================

test('handleSkillPickerKey clamps movement at both ends', t => {
	t.deepEqual(handleSkillPickerKey({upArrow: true}, 0, 3), {
		action: 'move',
		index: 0,
	});
	t.deepEqual(handleSkillPickerKey({downArrow: true}, 2, 3), {
		action: 'move',
		index: 2,
	});
	t.deepEqual(handleSkillPickerKey({downArrow: true}, 0, 3), {
		action: 'move',
		index: 1,
	});
});

test('handleSkillPickerKey ignores plain j and k so they stay typable', t => {
	t.deepEqual(handleSkillPickerKey({}, 1, 3), {action: 'ignore', index: 1});
});

test('handleSkillPickerKey reports escape as a close', t => {
	t.deepEqual(handleSkillPickerKey({escape: true}, 1, 3), {
		action: 'close',
		index: 1,
	});
});

test('handleSkillPickerKey accepts on tab, so the prompt never has to leave', t => {
	t.deepEqual(handleSkillPickerKey({tab: true}, 2, 3), {
		action: 'accept',
		index: 2,
	});
});

test('handleSkillPickerKey ignores tab when the list is empty', t => {
	t.deepEqual(handleSkillPickerKey({tab: true}, 0, 0), {
		action: 'ignore',
		index: 0,
	});
});

// ============================================================================
// handleSkillListKey: the same list, once Enter has handed it the focus
// ============================================================================

test('handleSkillListKey moves on arrows and clamps at both ends', t => {
	t.deepEqual(handleSkillListKey('', {upArrow: true}, 0, 3), {
		action: 'move',
		index: 0,
	});
	t.deepEqual(handleSkillListKey('', {downArrow: true}, 2, 3), {
		action: 'move',
		index: 2,
	});
	t.deepEqual(handleSkillListKey('', {downArrow: true}, 0, 3), {
		action: 'move',
		index: 1,
	});
});

test('handleSkillListKey moves on j and k, which the frozen input no longer needs', t => {
	t.deepEqual(handleSkillListKey('j', {}, 0, 3), {action: 'move', index: 1});
	t.deepEqual(handleSkillListKey('k', {}, 2, 3), {action: 'move', index: 1});
});

test('handleSkillListKey accepts on both enter and tab', t => {
	t.deepEqual(handleSkillListKey('', {return: true}, 1, 3), {
		action: 'accept',
		index: 1,
	});
	t.deepEqual(handleSkillListKey('', {tab: true}, 1, 3), {
		action: 'accept',
		index: 1,
	});
});

test('handleSkillListKey ignores an accept for a row that is not there', t => {
	t.deepEqual(handleSkillListKey('', {return: true}, 0, 0), {
		action: 'ignore',
		index: 0,
	});
});

test('handleSkillListKey hands the focus back on escape', t => {
	t.deepEqual(handleSkillListKey('', {escape: true}, 2, 3), {
		action: 'back',
		index: 2,
	});
});

test('handleSkillListKey ignores an ordinary letter', t => {
	t.deepEqual(handleSkillListKey('q', {}, 1, 3), {action: 'ignore', index: 1});
});

// ============================================================================
// discoverSkills
// ============================================================================

test('discoverSkills reads repo skills with their descriptions', async t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'do-pappardelle', 'Work through a TODO checklist.');
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(found, [
		{
			name: 'do-pappardelle',
			description: 'Work through a TODO checklist.',
			source: 'repo',
			kind: 'skill',
		},
	]);
});

test('discoverSkills tolerates a skill with no description', async t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'bare', null);
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.is(found[0]?.description, '');
});

test('discoverSkills reads commands, including nested ones', async t => {
	const repo = makeTmpDir();
	writeCommand(repo, 'deploy', 'Ship it.');
	writeCommand(repo, 'db/reset', 'Reset the database.');
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(found.map(f => f.name).sort(), ['db:reset', 'deploy']);
	t.true(found.every(f => f.kind === 'command'));
});

test('discoverSkills includes user skills and marks their source', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	writeSkill(repo, 'repo-skill', 'From the repo.');
	writeSkill(home, 'user-skill', 'From home.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => [f.name, f.source]),
		[
			['repo-skill', 'repo'],
			['user-skill', 'user'],
		],
	);
});

test('discoverSkills lets a repo entry hide a user entry of the same name', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	writeSkill(repo, 'shared', 'Repo version.');
	writeSkill(home, 'shared', 'User version.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.is(found.length, 1);
	t.is(found[0]?.description, 'Repo version.');
	t.is(found[0]?.source, 'repo');
});

test('discoverSkills returns an empty list when nothing is installed', async t => {
	t.deepEqual(
		await discoverSkills({repoRoot: makeTmpDir(), homeDir: makeTmpDir()}),
		[],
	);
});

test('discoverSkills skips a skill directory with no SKILL.md', async t => {
	const repo = makeTmpDir();
	fs.mkdirSync(path.join(repo, '.claude', 'skills', 'empty'), {
		recursive: true,
	});
	t.deepEqual(
		await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()}),
		[],
	);
});

test('discoverSkills sorts entries by name within each source', async t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'zebra', 'Z.');
	writeSkill(repo, 'alpha', 'A.');
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(
		found.map(f => f.name),
		['alpha', 'zebra'],
	);
});

test('discoverSkills reads a description from the top of a long SKILL.md', async t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'long', 'Near the top.');
	fs.appendFileSync(
		path.join(repo, '.claude', 'skills', 'long', 'SKILL.md'),
		'x'.repeat(64 * 1024),
	);
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.is(found[0]?.description, 'Near the top.');
});

test('discoverSkills reads frontmatter up to 4096 characters, not bytes', async t => {
	const repo = makeTmpDir();
	const dir = path.join(repo, '.claude', 'skills', 'cjk');
	fs.mkdirSync(dir, {recursive: true});
	// 1500 three-byte characters push the description past byte 4096 while
	// staying well inside the first 4096 characters.
	fs.writeFileSync(
		path.join(dir, 'SKILL.md'),
		`---\nname: ${'漢'.repeat(1500)}\ndescription: cjk desc\n---\nbody\n`,
	);
	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.is(found[0]?.description, 'cjk desc');
});

test('discoverSkills keeps the other scope when one skills path is a file', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	fs.mkdirSync(path.join(repo, '.claude'), {recursive: true});
	fs.writeFileSync(path.join(repo, '.claude', 'skills'), 'not a directory');
	writeCommand(repo, 'deploy', 'Ship it.');
	writeSkill(home, 'user-skill', 'From home.');
	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => [f.name, f.source]),
		[
			['deploy', 'repo'],
			['user-skill', 'user'],
		],
	);
});

test('discoverSkills follows a symlinked command file and directory', async t => {
	const repo = makeTmpDir();
	const shared = makeTmpDir();
	fs.writeFileSync(
		path.join(shared, 'linked.md'),
		'---\ndescription: Linked.\n---\n',
	);
	fs.mkdirSync(path.join(shared, 'ops'));
	fs.writeFileSync(path.join(shared, 'ops', 'restart.md'), 'Restart.\n');
	const commands = path.join(repo, '.claude', 'commands');
	fs.mkdirSync(commands, {recursive: true});
	fs.symlinkSync(
		path.join(shared, 'linked.md'),
		path.join(commands, 'linked.md'),
	);
	fs.symlinkSync(path.join(shared, 'ops'), path.join(commands, 'ops'));
	fs.symlinkSync(
		path.join(shared, 'missing.md'),
		path.join(commands, 'dangling.md'),
	);

	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(
		found.map(f => [f.name, f.description]),
		[
			['linked', 'Linked.'],
			['ops:restart', ''],
		],
	);
});

test('discoverSkills stops at a command symlink back to an ancestor', async t => {
	const repo = makeTmpDir();
	writeCommand(repo, 'loop/inner', null);
	const commands = path.join(repo, '.claude', 'commands');
	fs.symlinkSync(commands, path.join(commands, 'loop', 'back'));

	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(
		found.map(f => f.name),
		['loop:inner'],
	);
});

test('discoverSkills hides skills and commands marked user-invocable: false', async t => {
	const repo = makeTmpDir();
	writeSkill(repo, 'visible', 'Shown.');
	const hidden = path.join(repo, '.claude', 'skills', 'internal');
	fs.mkdirSync(hidden, {recursive: true});
	fs.writeFileSync(
		path.join(hidden, 'SKILL.md'),
		'---\nname: internal\ndescription: Model only.\nuser-invocable: false\n---\n',
	);
	const command = path.join(repo, '.claude', 'commands', 'quiet.md');
	fs.mkdirSync(path.dirname(command), {recursive: true});
	fs.writeFileSync(command, '---\nuser-invocable: false\n---\n');

	const found = await discoverSkills({repoRoot: repo, homeDir: makeTmpDir()});
	t.deepEqual(
		found.map(f => f.name),
		['visible'],
	);
});

type PluginSpec = {
	key: string;
	manifest?: Record<string, unknown>;
	projectPath?: string;
};

function installPlugin(home: string, spec: PluginSpec): string {
	const installPath = makeTmpDir();
	if (spec.manifest) {
		fs.mkdirSync(path.join(installPath, '.claude-plugin'));
		fs.writeFileSync(
			path.join(installPath, '.claude-plugin', 'plugin.json'),
			JSON.stringify(spec.manifest),
		);
	}

	const registry = path.join(
		home,
		'.claude',
		'plugins',
		'installed_plugins.json',
	);
	fs.mkdirSync(path.dirname(registry), {recursive: true});
	const current = fs.existsSync(registry)
		? (JSON.parse(fs.readFileSync(registry, 'utf8')) as {
				plugins: Record<string, unknown[]>;
			})
		: {plugins: {}};
	current.plugins[spec.key] = [
		{
			scope: spec.projectPath ? 'project' : 'user',
			installPath,
			...(spec.projectPath ? {projectPath: spec.projectPath} : {}),
		},
	];
	fs.writeFileSync(registry, JSON.stringify({version: 2, ...current}));
	return installPath;
}

function enablePlugins(
	root: string,
	file: string,
	keys: Record<string, boolean>,
) {
	fs.mkdirSync(path.join(root, '.claude'), {recursive: true});
	fs.writeFileSync(
		path.join(root, '.claude', file),
		JSON.stringify({enabledPlugins: keys}),
	);
}

test('discoverSkills lists enabled plugin skills and commands under the plugin name', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	const plugin = installPlugin(home, {
		key: 'tools@market',
		manifest: {name: 'tools'},
	});
	fs.mkdirSync(path.join(plugin, 'skills', 'lint'), {recursive: true});
	fs.writeFileSync(
		path.join(plugin, 'skills', 'lint', 'SKILL.md'),
		'---\ndescription: Lint it.\n---\n',
	);
	fs.mkdirSync(path.join(plugin, 'commands', 'db'), {recursive: true});
	fs.writeFileSync(path.join(plugin, 'commands', 'db', 'reset.md'), 'Reset.\n');
	enablePlugins(home, 'settings.json', {'tools@market': true});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => [f.name, f.source, f.kind, f.description]),
		[
			['tools:db:reset', 'plugin', 'command', ''],
			['tools:lint', 'plugin', 'skill', 'Lint it.'],
		],
	);
});

test('discoverSkills follows the skill and command paths a plugin manifest names', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	const plugin = installPlugin(home, {
		key: 'deep@market',
		manifest: {
			name: 'deep',
			skills: ['./skills/engineering/tdd', './bundle/'],
			commands: './extra/run.md',
		},
	});
	for (const dir of ['skills/engineering/tdd', 'bundle/review']) {
		fs.mkdirSync(path.join(plugin, dir), {recursive: true});
		fs.writeFileSync(path.join(plugin, dir, 'SKILL.md'), '---\n---\n');
	}

	fs.mkdirSync(path.join(plugin, 'skills', 'misc', 'unlisted'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(plugin, 'skills', 'misc', 'unlisted', 'SKILL.md'),
		'---\n---\n',
	);
	fs.mkdirSync(path.join(plugin, 'extra'));
	fs.writeFileSync(path.join(plugin, 'extra', 'run.md'), 'Run.\n');
	enablePlugins(home, 'settings.json', {'deep@market': true});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => f.name),
		['deep:review', 'deep:run', 'deep:tdd'],
	);
});

test('discoverSkills skips plugins that are disabled, not enabled here, or installed for another project', async t => {
	const repo = makeTmpDir();
	const home = makeTmpDir();
	const keys = ['off@m', 'repo-off@m', 'other-project@m', 'repo-on@m'];
	for (const key of keys) {
		const plugin = installPlugin(home, {
			key,
			projectPath: key === 'other-project@m' ? makeTmpDir() : undefined,
		});
		fs.mkdirSync(path.join(plugin, 'commands'));
		fs.writeFileSync(path.join(plugin, 'commands', 'go.md'), 'Go.\n');
	}

	installPlugin(home, {key: 'never-enabled@m'});
	enablePlugins(home, 'settings.json', {
		'off@m': false,
		'repo-off@m': true,
		'other-project@m': true,
	});
	enablePlugins(repo, 'settings.json', {'repo-on@m': true});
	enablePlugins(repo, 'settings.local.json', {'repo-off@m': false});

	const found = await discoverSkills({repoRoot: repo, homeDir: home});
	t.deepEqual(
		found.map(f => f.name),
		['repo-on:go'],
	);
});

// ============================================================================
// createSkillSnapshot
// ============================================================================

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return {promise, resolve, reject};
}

const rootsA = {repoRoot: '/repo-a', homeDir: '/home'};
const rootsB = {repoRoot: '/repo-b', homeDir: '/home'};

test('createSkillSnapshot holds nothing until a scan completes', async t => {
	const scan = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async () => scan.promise);
	const refreshed = store.refresh(rootsA);
	t.is(store.current(rootsA), undefined);
	scan.resolve([entry('alpha')]);
	t.deepEqual(await refreshed, [entry('alpha')]);
	t.deepEqual(store.current(rootsA), [entry('alpha')]);
});

test('createSkillSnapshot joins a scan already running for the same roots', async t => {
	const scan = deferred<SkillEntry[]>();
	let calls = 0;
	const store = createSkillSnapshot(async () => {
		calls++;
		return scan.promise;
	});
	const first = store.refresh(rootsA);
	const second = store.refresh(rootsA);
	scan.resolve([entry('alpha')]);
	t.deepEqual(await Promise.all([first, second]), [
		[entry('alpha')],
		[entry('alpha')],
	]);
	t.is(calls, 1);
	await store.refresh(rootsA);
	t.is(calls, 2);
});

test('createSkillSnapshot keeps the previous snapshot when a rescan fails', async t => {
	let next: () => Promise<SkillEntry[]> = async () => [entry('alpha')];
	const store = createSkillSnapshot(async () => next());
	await store.refresh(rootsA);
	next = async () => {
		throw new Error('EACCES');
	};
	t.deepEqual(await store.refresh(rootsA), [entry('alpha')]);
	t.deepEqual(store.current(rootsA), [entry('alpha')]);
});

test('createSkillSnapshot keeps the newer roots when an older scan lands last', async t => {
	const scanA = deferred<SkillEntry[]>();
	const scanB = deferred<SkillEntry[]>();
	const store = createSkillSnapshot(async roots =>
		roots === rootsA ? scanA.promise : scanB.promise,
	);
	const refreshA = store.refresh(rootsA);
	const refreshB = store.refresh(rootsB);
	scanB.resolve([entry('from-b')]);
	await refreshB;
	scanA.resolve([entry('from-a')]);
	await refreshA;
	t.deepEqual(store.current(rootsB), [entry('from-b')]);
	t.is(store.current(rootsA), undefined);
});

test('createSkillSnapshot does not serve a snapshot taken for other roots', async t => {
	const store = createSkillSnapshot(async roots => [entry(roots.repoRoot)]);
	await store.refresh(rootsA);
	t.is(store.current(rootsB), undefined);
	t.deepEqual(await store.refresh(rootsB), [entry('/repo-b')]);
});

test('SKILL_PICKER_MAX_VISIBLE keeps the box a sane height', t => {
	t.true(SKILL_PICKER_MAX_VISIBLE >= 3 && SKILL_PICKER_MAX_VISIBLE <= 8);
});

// ============================================================================
// clampSelection: the rendered highlight and the accepted entry must agree
// ============================================================================

test('clampSelection leaves an in-range index alone', t => {
	t.is(clampSelection(2, 5), 2);
});

test('clampSelection falls back to the first row when the list shrinks', t => {
	t.is(clampSelection(4, 2), 0);
});

test('clampSelection treats an index one past the end as out of range', t => {
	t.is(clampSelection(2, 2), 0);
});

test('clampSelection returns zero for an empty list', t => {
	t.is(clampSelection(3, 0), 0);
});

test('clampSelection floors a negative index at zero', t => {
	t.is(clampSelection(-1, 5), 0);
});

test('regression: a narrowed list never strands Enter on a missing entry', t => {
	// Arrow down to row 3, then type until only two entries survive. The
	// rendered highlight and the entry Enter accepts have to be the same row,
	// or Enter silently does nothing.
	const narrowed = [entry('do-pappardelle'), entry('do-personal')];
	const index = clampSelection(3, narrowed.length);
	t.is(index, 0);
	t.truthy(narrowed[index]);
});

// ============================================================================
// reanchorSelection
// ============================================================================

test('reanchorSelection follows the highlighted skill when a new one sorts ahead', t => {
	const after = [entry('do-alpha'), entry('do-new'), entry('do-plan')];
	t.is(reanchorSelection('do-plan', after), 2);
});

test('reanchorSelection falls back to the top when the highlighted skill is gone', t => {
	t.is(reanchorSelection('removed', [entry('a'), entry('b')]), 0);
});

test('reanchorSelection starts at the top when nothing was highlighted', t => {
	t.is(reanchorSelection(undefined, [entry('a'), entry('b')]), 0);
});
