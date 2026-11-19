// `--internal-state <verb>`: state changes that bash asks the binary to make,
// so that scripts never write state files or SQL themselves.

import {homedir} from 'node:os';
import {parseArgs} from 'node:util';
import {statusSocket} from './program-status-monitor.ts';
import {
	newSpaceIdentity,
	recordMainIdentity,
	spaceWorktreePath,
} from './space-identity.ts';
import {createStateDaos} from './state-daos.ts';
import {openStateDb} from './state-db.ts';

type Verb = (args: string[]) => number | Promise<number>;

function usage(message: string): number {
	console.error(`pappardelle --internal-state: ${message}`);
	return 2;
}

const verbs: Record<string, Verb> = {
	/**
	 * What idow records about a space before it starts the space's sessions.
	 * `--worktree <path>` is the space's worktree and `--main-root <path>` the
	 * main checkout's, recorded with the session names the space is created with.
	 * `--register --owner <pid>` holds the space for the process setting it up,
	 * `--created-issue` says this run created the space's issue,
	 * `--profile <name>` is the profile the space was created or reopened with,
	 * `--title=<title>` is the issue's title as idow read it from the tracker,
	 * and `--fresh` says the space's key has no earlier conversation to resume.
	 */
	async 'prepare-space'(args) {
		const {values, positionals} = parseArgs({
			args,
			allowPositionals: true,
			options: {
				repo: {type: 'string'},
				worktree: {type: 'string'},
				'main-root': {type: 'string'},
				register: {type: 'boolean'},
				owner: {type: 'string'},
				'created-issue': {type: 'boolean'},
				profile: {type: 'string'},
				title: {type: 'string'},
				fresh: {type: 'boolean'},
			},
		});
		const [key] = positionals;
		const {repo, worktree, 'main-root': mainRoot} = values;
		if (!repo || !worktree || !mainRoot || !key || positionals.length !== 1)
			return usage(
				'prepare-space needs --repo <name>, --worktree <path>, --main-root <path> and one space key',
			);
		const daos = createStateDaos({repo});
		// A registered key must always have an identity, so it is written first.
		await daos.spaceIdentities.record(
			newSpaceIdentity({
				repo,
				key,
				worktreePath: worktree,
				socket: statusSocket(process.env),
			}),
		);
		await recordMainIdentity(daos.spaceIdentities, {
			repo,
			mainRoot,
			env: process.env,
		});

		if (values.register) {
			const owner = Number(values.owner);
			if (!Number.isInteger(owner) || owner <= 0)
				return usage('--register needs --owner <pid>');
			await daos.registry.reserveStart(key, owner);
		}

		if (values.fresh) await daos.agentSessions.clear(key);
		if (values['created-issue']) await daos.issueMeta.markCreated(key);
		const patch = {
			...(values.profile === undefined ? {} : {profile: values.profile}),
			...(values.title === undefined ? {} : {issueTitle: values.title}),
		};
		if (Object.keys(patch).length > 0) await daos.spaceState.write(key, patch);

		return 0;
	},

	/**
	 * Record that idow is starting a space's agent session with the agent
	 * profile `--agent-profile <name>`, a claude one when `--claude` is given.
	 * The session's hook records the agent's session id under it.
	 */
	async 'launch-agent'(args) {
		const {values, positionals} = parseArgs({
			args,
			allowPositionals: true,
			options: {
				repo: {type: 'string'},
				'agent-profile': {type: 'string'},
				claude: {type: 'boolean'},
			},
		});
		const [key] = positionals;
		const {repo, 'agent-profile': name} = values;
		if (!repo || !name || !key || positionals.length !== 1)
			return usage(
				'launch-agent needs --repo <name>, --agent-profile <name> and one space key',
			);
		await createStateDaos({repo}).spaceState.write(key, {
			agentProfile: {name, isClaude: values.claude === true},
		});
		return 0;
	},

	/**
	 * Where the space's worktree is: the one stored for it, else where a new
	 * space's goes. idow creates it there.
	 */
	'worktree-path'(args) {
		const {values, positionals} = parseArgs({
			args,
			allowPositionals: true,
			options: {repo: {type: 'string'}},
		});
		const [key] = positionals;
		const {repo} = values;
		if (!repo || !key || positionals.length !== 1)
			return usage('worktree-path needs --repo <name> and one space key');
		const lookup = spaceWorktreePath(
			createStateDaos({repo}).spaceIdentities,
			homedir(),
			repo,
			key,
		);
		if (lookup.kind === 'unreadable') throw lookup.error;
		console.log(lookup.path);
		return 0;
	},

	/** `space get` and `space list` for idow, in the repo `--repo <name>` names. */
	async space(args) {
		// Every other argument is the space command's own, passed on in order.
		const {values, tokens} = parseArgs({
			args,
			options: {repo: {type: 'string'}},
			strict: false,
			allowPositionals: true,
			tokens: true,
		});
		const {repo} = values;
		if (typeof repo !== 'string' || !repo)
			return usage('space needs --repo <name>');
		const repoArgs = new Set(
			tokens.flatMap(token =>
				token.kind === 'option' && token.name === 'repo'
					? token.inlineValue
						? [token.index]
						: [token.index, token.index + 1]
					: [],
			),
		);
		const {defaultSpaceCommandDeps, runSpaceCommand} =
			await import('./space-command.ts');
		return runSpaceCommand(
			args.filter((_, index) => !repoArgs.has(index)),
			defaultSpaceCommandDeps({repo, resolveKey: key => key}),
		);
	},

	/** Create or upgrade the database at a path, for the hooks' tests. */
	migrate([dbPath]) {
		if (!dbPath) return usage('migrate needs a database path');
		openStateDb(dbPath);
		return 0;
	},
};

const [name, ...args] = process.argv.slice(2);
const verb = name ? verbs[name] : undefined;
try {
	process.exitCode = verb
		? await verb(args)
		: usage(name ? `unknown verb ${name}` : 'missing verb');
} catch (error) {
	console.error(
		`pappardelle --internal-state ${name}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
