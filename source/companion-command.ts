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
import {MAIN_PANE} from './companion-splits.ts';
import {
	requestCompanionLayout,
	requestCompanionWidth,
	type LayoutOutcome,
} from './companion-width.ts';
import {NoTargetSpaceError} from './space-target.ts';
import type {StateDaos} from './state-daos.ts';
import {processIsAlive, type TuiMarkerDao} from './tui-marker.ts';

export interface CompanionCommandDeps {
	/** Resolves --space (or $PAPPARDELLE_SPACE when undefined) to a key. */
	resolveSpace: (flag: string | undefined) => string;
	/** The repo's stores, built once they are used so --help works outside a repo. */
	daos: () => Pick<
		StateDaos,
		'companionWidths' | 'companionRequests' | 'tuiMarker'
	>;
	readStdin?: () => string | undefined;
	out?: (text: string) => void;
	err?: (text: string) => void;
}

function defaultReadStdin(): string | undefined {
	if (process.stdin.isTTY) return undefined;
	return readFileSync(0, 'utf8').replace(/\n$/, '');
}

function tuiIsRunning(tuiMarker: TuiMarkerDao): boolean {
	const marker = tuiMarker.read();
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
			const label = `${created ? 'Opened' : 'Restarted'} ${command.pane} in ${space}'s companion`;
			if (
				command.pane === MAIN_PANE ||
				(!created && command.size === undefined)
			) {
				deps.out(label);
				return 0;
			}

			return relayout(deps, label, space);
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
			return relayout(
				deps,
				`Resized ${command.pane} in ${space}'s companion to ${command.size}`,
				space,
			);
		}

		case 'close': {
			closeCompanionPane(space, command.pane);
			return relayout(
				deps,
				`Closed ${command.pane} in ${space}'s companion`,
				space,
			);
		}

		case 'list': {
			const panes = listCompanion(space);
			deps.out(
				command.json
					? JSON.stringify(
							panes.map(
								({
									name,
									paneId,
									split,
									size,
									command,
									width,
									height,
									shown,
								}) => ({
									name,
									paneId,
									split,
									size,
									command,
									width,
									height,
									shown,
								}),
							),
							null,
							2,
						)
					: formatPaneList(panes),
			);
			return 0;
		}

		case 'width': {
			const width = command.width === 'reset' ? null : command.width;
			const label =
				width === null
					? `Reset ${space}'s companion width`
					: `Stored ${space} companion width ${width}`;
			const {companionWidths, companionRequests, tuiMarker} = deps.daos();
			const result = await requestCompanionWidth({
				widths: companionWidths,
				requests: companionRequests,
				space,
				width,
				tuiIsRunning: () => tuiIsRunning(tuiMarker),
			});
			if (result.outcome === 'applied') {
				deps.out(`Applied ${space} companion width: ${result.columns} columns`);
				return 0;
			}

			return report(deps, label, 'applies', result, space);
		}
	}
}

/**
 * Print where a change landed in the TUI, as the outcome of its layout
 * request says.
 */
function report(
	deps: Required<CompanionCommandDeps>,
	label: string,
	verb: 'applies' | 'shows',
	result: LayoutOutcome,
	space: string,
): number {
	switch (result.outcome) {
		case 'applied': {
			deps.out(`${label}; the TUI shows it`);
			return 0;
		}

		case 'stored': {
			deps.out(`${label}; ${verb} when ${space} is selected`);
			return 0;
		}

		case 'no-pane': {
			deps.out(`${label}; ${verb} when the companion pane is showing`);
			return 0;
		}

		case 'deferred': {
			deps.out(`${label}; ${verb} when the open dialog closes`);
			return 0;
		}

		case 'no-tui': {
			deps.out(`${label}; ${verb} when Pappardelle next launches`);
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

async function relayout(
	deps: Required<CompanionCommandDeps>,
	label: string,
	space: string,
): Promise<number> {
	const {companionRequests, tuiMarker} = deps.daos();
	const result = await requestCompanionLayout({
		requests: companionRequests,
		space,
		tuiIsRunning: () => tuiIsRunning(tuiMarker),
	});
	return report(deps, label, 'shows', result, space);
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
