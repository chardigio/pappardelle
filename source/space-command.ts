// `pappardelle space get` and `space list`: what a space is, answered from
// the stores, so agents, hooks and scripts stop deriving session names,
// worktree paths and state file locations from the issue key themselves.

import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {parseArgs, promisify} from 'node:util';
import {
	AGENT_PANE_FORMAT,
	readAgentStatus,
	statusPaneOf,
} from './agent-state.ts';
import {spaceStatusKey} from './claude-status.ts';
import {SPACE_HELP, SPACE_USAGE} from './cli-args.ts';
import {companionMainPane} from './companion.ts';
import {statusSocket, statusSocketFlag} from './program-status-monitor.ts';
import type {ProgramStatusInfo} from './program-status.ts';
import type {PipelineStatus} from './providers/types.ts';
import type {SpacePhase} from './space-registry.ts';
import type {SpaceState} from './space-state.ts';
import {callerSpace, worktreePathFor} from './space-target.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import type {StateDaos} from './state-daos.ts';
import type {Unreadable} from './state-db.ts';
import {
	exactSessionTarget,
	getSessionNames,
	type OuterTmuxRunner,
} from './tmux.ts';
import {compareSpaceNames} from './workspace-refresh.ts';

const STATUS_FIELDS = [
	'status',
	'app',
	'kind',
	'tool',
	'activity',
	'progress',
	'title',
	'message',
	'source',
] as const;

export type SpaceStatus = Pick<
	ProgramStatusInfo,
	(typeof STATUS_FIELDS)[number]
>;

export type SpaceRecord = {
	repo: string;
	key: string;
	/** `closed` when the space is not open but its state is still stored. */
	phase: SpacePhase | 'closed';
	title: string | null;
	worktreePath: string;
	branch: string | null;
	profile: string | null;
	/** Agent profile to its recorded session id. */
	agentSessions: Record<string, string>;
	tmux: {
		socket: string;
		socketFlag: '-S' | '-L';
		agentSession: string;
		companionSession: string;
		agentTarget: string;
		companionTarget: string;
	};
	panes: {agent: string | null; companion: string | null};
	prNumber: number | null;
	prLinks: Array<{url: string; number: number; remoteBranch: string}>;
	pipeline: PipelineStatus | null;
	unresolvedCommentCount: number | null;
	status: SpaceStatus | null;
};

/**
 * The parts of a record read only when asked for: each starts a process, or
 * reads a store whose failure must not fail lookups that don't need it.
 */
export type SpaceGroup = 'panes' | 'branch' | 'status' | 'agentSessions';
const ALL_GROUPS: ReadonlySet<SpaceGroup> = new Set([
	'panes',
	'branch',
	'status',
	'agentSessions',
]);

export type SpaceLookup =
	| {kind: 'space'; record: SpaceRecord}
	| {kind: 'unknown'}
	| Unreadable;

export type SpaceDaos = Pick<
	StateDaos,
	'registry' | 'spaceState' | 'agentSessions' | 'claudeStatus' | 'programStatus'
>;

export type SpaceCommandDeps = {
	/** The repo of the checkout the command runs in. Throws outside one. */
	repo: () => string;
	/** The main checkout's root. Throws outside a git checkout. */
	mainRoot: () => string;
	daos: (repo: string) => SpaceDaos;
	home: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** The inner tmux server, read only. */
	runner: OuterTmuxRunner;
	/** The branch checked out in a directory; null when detached or missing. */
	gitBranch: (directory: string) => Promise<string | null>;
	/** A typed issue key as Pappardelle normalizes it. */
	resolveKey: (raw: string) => string;
	out: (text: string) => void;
	err: (text: string) => void;
};

type PaneRow = {paneId: string; name: string | null; agentLine: string};

/** One read of every pane on the inner server, by session. */
class PaneListing {
	private sessions: Map<string, PaneRow[]> | undefined;

	constructor(private readonly runner: OuterTmuxRunner) {}

	rows(session: string): PaneRow[] {
		this.sessions ??= this.read();
		return this.sessions.get(session) ?? [];
	}

	private read(): Map<string, PaneRow[]> {
		const result = this.runner([
			'list-panes',
			'-a',
			'-F',
			`#{session_name}\t#{pane_id}\t#{@pappa_pane}\t${AGENT_PANE_FORMAT}`,
		]);
		const sessions = new Map<string, PaneRow[]>();
		if (result.error || result.status !== 0) return sessions;
		for (const line of result.stdout.split('\n').filter(Boolean)) {
			const [session = '', paneId = '', name = '', ...rest] = line.split('\t');
			const rows = sessions.get(session) ?? [];
			rows.push({paneId, name: name || null, agentLine: rest.join('\t')});
			sessions.set(session, rows);
		}

		return sessions;
	}
}

function storedPhase(
	key: string,
	daos: SpaceDaos,
	agentSession: string,
	runner: OuterTmuxRunner,
	state: SpaceState | null,
): SpaceRecord['phase'] | {kind: 'unknown'} | Unreadable {
	if (key === MAIN_WORKTREE_KEY) return 'open';
	const lookup = daos.registry.phase(key);
	if (lookup.kind === 'unreadable') return lookup;
	if (lookup.kind === 'phase') return lookup.phase;
	// Without lifecycle records the registry learns of a space only once idow
	// has finished setting it up, so a live session it lacks is one starting.
	if (
		!daos.registry.keepsLifecycle &&
		runner(['has-session', '-t', exactSessionTarget(agentSession)]).status === 0
	)
		return 'starting';
	return state ? 'closed' : {kind: 'unknown'};
}

function statusOf(info: ProgramStatusInfo | null): SpaceStatus | null {
	if (!info) return null;
	const status: Record<string, unknown> = {};
	for (const field of STATUS_FIELDS) {
		if (info[field] !== undefined) status[field] = info[field];
	}

	return status as SpaceStatus;
}

export async function spaceRecord(
	key: string,
	repo: string,
	deps: SpaceCommandDeps,
	groups: ReadonlySet<SpaceGroup>,
	listing = new PaneListing(deps.runner),
): Promise<SpaceLookup> {
	const daos = deps.daos(repo);
	const stateLookup = daos.spaceState.lookup(key);
	if (stateLookup.kind === 'unreadable') return stateLookup;
	const state = stateLookup.kind === 'state' ? stateLookup.state : null;
	const sessions = getSessionNames(key, repo);
	const phase = storedPhase(key, daos, sessions.agent, deps.runner, state);
	if (typeof phase !== 'string') return phase;
	const agentSessions = groups.has('agentSessions')
		? daos.agentSessions.sessions(key)
		: {kind: 'sessions' as const, sessions: {}};
	if (agentSessions.kind === 'unreadable') return agentSessions;

	const worktreePath =
		key === MAIN_WORKTREE_KEY
			? deps.mainRoot()
			: worktreePathFor(deps.home, repo, key);
	const branch =
		groups.has('branch') || (groups.has('status') && key === MAIN_WORKTREE_KEY)
			? await deps.gitBranch(worktreePath)
			: null;
	const socket = statusSocket(deps.env);
	const agentPane =
		groups.has('panes') || groups.has('status')
			? statusPaneOf(
					listing.rows(sessions.agent).map(row => row.agentLine),
					socket,
				)
			: null;
	const companionPane = groups.has('panes')
		? companionMainPane(listing.rows(sessions.companion))
		: undefined;
	const status = groups.has('status')
		? await readAgentStatus(key, agentPane, {
				hookKey: await spaceStatusKey(
					daos.claudeStatus,
					repo,
					key,
					async () => branch ?? undefined,
				),
				readHook: async hookKey => daos.claudeStatus.read(hookKey),
				readSnapshot: async (space, pane) =>
					daos.programStatus.read(space, pane),
			})
		: null;

	return {
		kind: 'space',
		record: {
			repo,
			key,
			phase,
			title: state?.issueTitle ?? null,
			worktreePath,
			branch,
			profile: state?.profile ?? null,
			agentSessions: agentSessions.sessions,
			tmux: {
				socket,
				socketFlag: statusSocketFlag(socket),
				agentSession: sessions.agent,
				companionSession: sessions.companion,
				agentTarget: exactSessionTarget(sessions.agent),
				companionTarget: exactSessionTarget(sessions.companion),
			},
			panes: {
				agent: agentPane?.id ?? null,
				companion: companionPane?.paneId ?? null,
			},
			prNumber: state?.prNumber ?? null,
			prLinks: (state?.prLinks ?? []).map(({url, number, remoteBranch}) => ({
				url,
				number,
				remoteBranch,
			})),
			pipeline: state?.pipeline ?? null,
			unresolvedCommentCount: state?.unresolvedCommentCount ?? null,
			status: statusOf(status),
		},
	};
}

const STORED = 'stored';
/** `agentSessions` is keyed by agent profile, so any one name below it is a path. */
const ANY_KEY = 'any-key';
type SchemaNode =
	| SpaceGroup
	| typeof STORED
	| typeof ANY_KEY
	| {[field: string]: SchemaNode};

/** The paths `--field` accepts, and the group each one needs. */
const SCHEMA: SchemaNode = {
	repo: STORED,
	key: STORED,
	phase: STORED,
	title: STORED,
	worktreePath: STORED,
	branch: 'branch',
	profile: STORED,
	agentSessions: ANY_KEY,
	tmux: {
		socket: STORED,
		socketFlag: STORED,
		agentSession: STORED,
		companionSession: STORED,
		agentTarget: STORED,
		companionTarget: STORED,
	},
	panes: {agent: 'panes', companion: 'panes'},
	prNumber: STORED,
	prLinks: STORED,
	pipeline: STORED,
	unresolvedCommentCount: STORED,
	status: Object.fromEntries(
		STATUS_FIELDS.map(field => [field, 'status' as const]),
	),
};

function leafGroups(node: SchemaNode): SpaceGroup[] {
	if (node === STORED) return [];
	if (node === ANY_KEY) return ['agentSessions'];
	if (typeof node === 'string') return [node];
	return Object.values(node).flatMap(inner => leafGroups(inner));
}

/** The groups a field path needs, or null when no record has the path. */
function groupsOf(path: string): SpaceGroup[] | null {
	const parts = path.split('.');
	let node = SCHEMA;
	for (const [index, part] of parts.entries()) {
		if (node === ANY_KEY)
			return index === parts.length - 1 && part ? leafGroups(node) : null;
		if (typeof node === 'string' || !Object.hasOwn(node, part)) return null;
		node = node[part]!;
	}

	return leafGroups(node);
}

function valueAt(record: SpaceRecord, path: string): unknown {
	let value: unknown = record;
	for (const part of path.split('.')) {
		value =
			value && typeof value === 'object'
				? (value as Record<string, unknown>)[part]
				: undefined;
	}

	return value ?? null;
}

function fieldText(value: unknown): string {
	if (value === null) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function plainLines(value: unknown, prefix: string): string[] {
	if (Array.isArray(value)) {
		return [
			`${prefix}: ${value.map(item => (item as {url: string}).url).join(' ')}`,
		];
	}

	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([field, inner]) =>
			plainLines(inner, prefix ? `${prefix}.${field}` : field),
		);
	}

	return [`${prefix}: ${fieldText(value ?? null)}`];
}

function table(records: SpaceRecord[]): string {
	const rows = [
		['KEY', 'PHASE', 'STATUS', 'BRANCH', 'TITLE'],
		...records.map(record => [
			record.key,
			record.phase,
			record.status?.status ?? '',
			record.branch ?? '',
			record.title ?? '',
		]),
	];
	const widths = rows[0]!.map((_, column) =>
		Math.max(...rows.map(row => row[column]!.length)),
	);
	return rows
		.map(row =>
			row
				.map((cell, column) =>
					column === row.length - 1 ? cell : cell.padEnd(widths[column]!),
				)
				.join('  ')
				.trimEnd(),
		)
		.join('\n');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function usage(deps: SpaceCommandDeps, message?: string): number {
	if (message) deps.err(message);
	deps.err(SPACE_USAGE);
	return 2;
}

const NOT_IN_A_REPO =
	"Not in a git repository; run it from a checkout of the space's repo";

/** The repo of the checkout the command runs in, if it runs in one. */
function checkoutRepo(deps: SpaceCommandDeps): string | undefined {
	try {
		return deps.repo();
	} catch {
		return undefined;
	}
}

type Target =
	| {kind: 'space'; key: string; repo: string; typed: boolean}
	| {kind: 'not-in-a-space'}
	| {kind: 'not-in-a-repo'};

function named(key: string, repo: string | undefined, typed: boolean): Target {
	return repo === undefined
		? {kind: 'not-in-a-repo'}
		: {kind: 'space', key, repo, typed};
}

/** The space to answer for, and the repo it belongs to. */
function target(raw: string | undefined, deps: SpaceCommandDeps): Target {
	if (raw !== undefined) return named(raw, checkoutRepo(deps), true);
	const own = deps.env['PAPPARDELLE_SPACE']?.trim();
	// A session started in a nested repo has a git dir that names that repo,
	// so its own space's repo comes from its environment.
	if (own)
		return named(
			own,
			deps.env['PAPPARDELLE_REPO']?.trim() || checkoutRepo(deps),
			false,
		);
	let checkout: {repoName: string; mainRoot: string};
	try {
		checkout = {repoName: deps.repo(), mainRoot: deps.mainRoot()};
	} catch {
		return {kind: 'not-in-a-space'};
	}

	const key = callerSpace({
		env: {},
		cwd: deps.cwd,
		home: deps.home,
		checkout,
	});
	return key === undefined
		? {kind: 'not-in-a-space'}
		: {kind: 'space', key, repo: checkout.repoName, typed: false};
}

async function runGet(args: string[], deps: SpaceCommandDeps): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: {
				json: {type: 'boolean'},
				field: {type: 'string', multiple: true},
			},
		});
	} catch (error) {
		return usage(deps, errorMessage(error));
	}

	const {values, positionals} = parsed;
	if (positionals.length > 1) return usage(deps, 'space get takes one KEY');
	const fields = values.field ?? [];
	const groups = new Set<SpaceGroup>();
	for (const field of fields) {
		const needed = field ? groupsOf(field) : null;
		if (!needed) return usage(deps, `No field ${field || '(empty)'}`);
		for (const group of needed) groups.add(group);
	}

	const wanted = fields.length > 0 ? groups : ALL_GROUPS;
	const space = target(positionals[0], deps);
	if (space.kind === 'not-in-a-repo') {
		deps.err(NOT_IN_A_REPO);
		return 1;
	}

	if (space.kind === 'not-in-a-space') {
		deps.err('Not in a Pappardelle space; pass a KEY');
		return 1;
	}

	let lookup = await spaceRecord(space.key, space.repo, deps, wanted);
	if (lookup.kind === 'unknown' && space.typed) {
		const resolved = deps.resolveKey(space.key);
		if (resolved !== space.key)
			lookup = await spaceRecord(resolved, space.repo, deps, wanted);
	}

	if (lookup.kind === 'unknown') {
		deps.err(`No space ${space.key}`);
		return 1;
	}

	if (lookup.kind === 'unreadable') {
		deps.err(
			`Could not read the state of ${space.key}: ${errorMessage(lookup.error)}`,
		);
		return 3;
	}

	const {record} = lookup;
	if (fields.length === 1) deps.out(fieldText(valueAt(record, fields[0]!)));
	else if (fields.length > 1)
		deps.out(
			JSON.stringify(
				Object.fromEntries(
					fields.map(field => [field, valueAt(record, field)]),
				),
			),
		);
	else if (values.json) deps.out(JSON.stringify(record, null, 2));
	else deps.out(plainLines(record, '').join('\n'));
	return 0;
}

async function runList(
	args: string[],
	deps: SpaceCommandDeps,
): Promise<number> {
	let json: boolean | undefined;
	try {
		({
			values: {json},
		} = parseArgs({args, options: {json: {type: 'boolean'}}}));
	} catch (error) {
		return usage(deps, errorMessage(error));
	}

	const repo = checkoutRepo(deps);
	if (repo === undefined) {
		deps.err(NOT_IN_A_REPO);
		return 1;
	}

	let open: string[];
	try {
		open = deps.daos(repo).registry.openSpaces() ?? [];
	} catch (error) {
		deps.err(`Could not read the open spaces: ${errorMessage(error)}`);
		return 3;
	}

	const listing = new PaneListing(deps.runner);
	const keys = [MAIN_WORKTREE_KEY, ...open.sort(compareSpaceNames)];
	const lookups = await Promise.all(
		keys.map(async key => spaceRecord(key, repo, deps, ALL_GROUPS, listing)),
	);
	const records: SpaceRecord[] = [];
	for (const [index, lookup] of lookups.entries()) {
		if (lookup.kind === 'unreadable') {
			deps.err(
				`Could not read the state of ${keys[index]!}: ${errorMessage(lookup.error)}`,
			);
			return 3;
		}

		if (lookup.kind === 'space') records.push(lookup.record);
	}

	deps.out(json ? JSON.stringify(records, null, 2) : table(records));
	return 0;
}

/** Exit codes: 0, 1 for no such space, 2 for usage, 3 when a store cannot be read. */
export async function runSpaceCommand(
	argv: string[],
	deps: SpaceCommandDeps,
): Promise<number> {
	const [verb, ...args] = argv;
	if (verb === '--help' || verb === '-h' || args.includes('--help')) {
		deps.out(SPACE_HELP);
		return 0;
	}

	if (verb === 'get') return runGet(args, deps);
	if (verb === 'list') return runList(args, deps);
	return usage(deps);
}

const exec = promisify(execFile);

export async function gitBranch(directory: string): Promise<string | null> {
	try {
		const {stdout} = await exec(
			'git',
			['symbolic-ref', '--quiet', '--short', 'HEAD'],
			{cwd: directory, encoding: 'utf8', timeout: 5000},
		);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export function defaultSpaceCommandDeps(
	deps: Pick<
		SpaceCommandDeps,
		'repo' | 'mainRoot' | 'daos' | 'resolveKey' | 'runner'
	>,
): SpaceCommandDeps {
	return {
		...deps,
		home: homedir(),
		env: process.env,
		cwd: process.cwd(),
		gitBranch,
		out: text => console.log(text),
		err: text => console.error(text),
	};
}
