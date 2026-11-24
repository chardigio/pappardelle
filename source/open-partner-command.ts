import type {PartnerAgent} from './partner-agents.ts';

// `pappardelle <partner name>` (space_open with a partner's name). A partner
// is no issue, so the input must never reach idow, which would file it as a
// new issue's description. A coordinator reopens a space whose session is
// gone the same way, so a launched partner starts here like a reopened space.

export type OpenPartnerDeps = {
	/** Whether the partner's agent session is up. */
	running: () => boolean;
	/** Start a launched partner's agent session; `fresh` skips its recorded conversation. */
	start: (fresh: boolean) => Promise<boolean>;
	/** Resolves false when its agent didn't report a start after `since`. */
	waitForAgent: (since: number) => Promise<boolean>;
	now: () => number;
	print: (line: string) => void;
	printError: (line: string) => void;
};

export async function runOpenPartnerCommand(
	partner: PartnerAgent,
	options: {resume?: boolean; wait: boolean},
	deps: OpenPartnerDeps,
): Promise<number> {
	const {name, attach} = partner;
	if (attach) {
		if (deps.running()) {
			deps.print(
				`${name} is a partner agent on its own tmux server, and it is running`,
			);
			return 0;
		}

		const server = `${attach.socket.startsWith('/') ? '-S' : '-L'} ${attach.socket}`;
		deps.printError(
			`${name} is a partner agent that runs outside Pappardelle (tmux ${server}, session ${attach.session}), and it isn't running. Pappardelle never starts it: start it where it is set up`,
		);
		return 1;
	}

	if (deps.running()) {
		deps.print(`Partner agent ${name} is running`);
		return 0;
	}

	const since = deps.now();
	if (!(await deps.start(options.resume === false))) {
		deps.printError(`Could not start partner agent ${name}`);
		return 1;
	}

	deps.print(`Partner agent ${name} started`);
	if (options.wait && !(await deps.waitForAgent(since))) {
		deps.printError(
			`${name} started, but its agent was not confirmed to start`,
		);
		return 3;
	}

	return 0;
}
