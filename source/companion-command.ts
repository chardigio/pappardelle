import {readFileSync} from 'node:fs';
import {
	CompanionUsageError,
	parseCompanionArgs,
	type CompanionCommand,
} from './companion-args.ts';
import {
	closeCompanionPane,
	CompanionError,
	formatPaneList,
	listCompanion,
	readCompanionPane,
	resizeCompanionPane,
	runInCompanion,
	sendCompanionKeys,
} from './companion.ts';
import {requestCompanionWidth} from './companion-width.ts';
import {NoTargetSpaceError} from './space-target.ts';
import {
	DEFAULT_REPO_STATE_ROOT,
	processIsAlive,
	readTuiMarker,
} from './tui-marker.ts';

export interface CompanionCommandDeps {
	/** Resolves --space (or $PAPPARDELLE_SPACE when undefined) to a key. */
	resolveSpace: (flag: string | undefined) => string;
	/** Needed only after parsing, so --help works outside a repo. */
	repoName: () => string;
	readStdin?: () => string | undefined;
	out?: (text: string) => void;
	err?: (text: string) => void;
}

function defaultReadStdin(): string | undefined {
	if (process.stdin.isTTY) return undefined;
	return readFileSync(0, 'utf8').replace(/\n$/, '');
}

function tuiIsRunning(repoName: string): boolean {
	const marker = readTuiMarker(DEFAULT_REPO_STATE_ROOT, repoName);
	return marker !== null && processIsAlive(marker.pid);
}

async function execute(
	command: Exclude<CompanionCommand, {verb: 'help'}>,
	space: string,
	deps: Required<CompanionCommandDeps>,
): Promise<number> {
	switch (command.verb) {
		case 'run': {
			const {created} = runInCompanion(space, command);
			deps.out(
				`${created ? 'Opened' : 'Restarted'} ${command.pane} in ${space}'s companion`,
			);
			return 0;
		}

		case 'keys': {
			const text =
				command.keys.length === 0 && command.text === undefined
					? deps.readStdin()
					: command.text;
			if (command.keys.length === 0 && !text && !command.enter) {
				deps.err(
					'Usage: pappardelle companion keys [--pane NAME] [--no-enter] [--keys KEY]... [text]',
				);
				return 1;
			}

			sendCompanionKeys(space, {...command, text});
			return 0;
		}

		case 'read': {
			deps.out(readCompanionPane(space, command));
			return 0;
		}

		case 'resize': {
			resizeCompanionPane(space, command);
			return 0;
		}

		case 'close': {
			closeCompanionPane(space, command.pane);
			deps.out(`Closed ${command.pane} in ${space}'s companion`);
			return 0;
		}

		case 'list': {
			const panes = listCompanion(space);
			deps.out(
				command.json
					? JSON.stringify(
							panes.map(({name, paneId, command, width, height, active}) => ({
								name,
								paneId,
								command,
								width,
								height,
								active,
							})),
							null,
							2,
						)
					: formatPaneList(panes),
			);
			return 0;
		}

		case 'width': {
			const repoName = deps.repoName();
			const width = command.width === 'reset' ? null : command.width;
			const label =
				width === null
					? `Reset ${space}'s companion width`
					: `Stored ${space} companion width ${width}`;
			const result = await requestCompanionWidth({
				repoName,
				space,
				width,
				tuiIsRunning: () => tuiIsRunning(repoName),
			});
			switch (result.outcome) {
				case 'applied': {
					deps.out(
						`Applied ${space} companion width: ${result.columns} columns`,
					);
					return 0;
				}

				case 'stored': {
					deps.out(`${label}; applies when ${space} is selected`);
					return 0;
				}

				case 'no-tui': {
					deps.out(`${label}; applies when Pappardelle next launches`);
					return 0;
				}

				case 'failed': {
					deps.err(`${label}; the TUI could not apply it`);
					return 1;
				}

				case 'no-ack': {
					deps.err(`${label}; the running TUI did not confirm`);
					return 1;
				}
			}
		}
	}
}

export async function runCompanionCommand(
	argv: readonly string[],
	options: CompanionCommandDeps,
): Promise<number> {
	const deps: Required<CompanionCommandDeps> = {
		readStdin: defaultReadStdin,
		out: text => console.log(text),
		err: text => console.error(text),
		...options,
	};
	try {
		const command = parseCompanionArgs(argv);
		if (command.verb === 'help') {
			deps.out(command.text);
			return 0;
		}

		return await execute(command, deps.resolveSpace(command.space), deps);
	} catch (error) {
		if (
			error instanceof CompanionUsageError ||
			error instanceof CompanionError ||
			error instanceof NoTargetSpaceError
		) {
			deps.err(error.message);
			return error instanceof CompanionUsageError ? 2 : 1;
		}

		throw error;
	}
}
