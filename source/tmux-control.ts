import {spawn, type ChildProcess} from 'node:child_process';

// A tmux command sent over a long-lived control-mode client costs tens of
// microseconds; the same command as its own `tmux` process costs about two
// milliseconds, and the attach path chains a dozen of them.

type Pending = {
	resolve: (stdout: string) => void;
	reject: (error: Error) => void;
	command: string;
	output: string[];
};

// tmux answers each command of a list separately and drops the rest of a
// list at the first failure, so every list sent ends by printing this: its
// reply, or a failure before it, is where the list's answer ends.
const REPLY_END = 'pappardelle-control-reply-end';

/** One argument as tmux's command parser reads it back unchanged. */
export function quoteTmuxArgument(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// Commands that hold a client's command queue until something else happens,
// or that end the server or client the queue runs on.
const HELD_COMMANDS = new Set([
	'attach-session',
	'attach',
	'command-prompt',
	'confirm-before',
	'detach-client',
	'display-popup',
	'kill-server',
	'run-shell',
]);

/**
 * The command list as one control-mode line, or undefined when it has to run
 * as a process: a control client reads one line per command list and runs
 * them in order, so a command that waits would hold every later one.
 */
export function controlCommandLine(
	args: readonly string[],
): string | undefined {
	if (args.some(arg => /[\n\r\0]/.test(arg))) return undefined;
	let start = 0;
	for (let index = 0; index <= args.length; index++) {
		if (index < args.length && args[index] !== ';') continue;
		const command = args.slice(start, index);
		start = index + 1;
		const name = command[0];
		if (name === undefined || HELD_COMMANDS.has(name)) return undefined;
		if (
			name === 'wait-for' &&
			!command.includes('-S') &&
			!command.includes('-U')
		)
			return undefined;
	}

	return args
		.map(arg => (arg === ';' ? ';' : quoteTmuxArgument(arg)))
		.join(' ');
}

/** The failure a `tmux` process would have reported for the same command. */
function commandError(command: string, stderr: string): Error {
	return Object.assign(
		new Error(`Command failed: tmux ${command}\n${stderr}`),
		{
			code: 1,
			killed: false,
			signal: null,
			stdout: '',
			stderr: `${stderr}\n`,
		},
	);
}

export class TmuxControlClient {
	private readonly pending: Pending[] = [];
	private buffer = '';
	private block: string[] | undefined;
	private blockNumber = '';
	// The client's own attach or new-session reports before any command sent.
	private awaitingStart = true;
	private closed = false;
	private readonly child: ChildProcess;

	constructor(tmuxArgs: string[], options: {cwd: string}) {
		this.child = spawn('tmux', tmuxArgs, {
			cwd: options.cwd,
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		this.child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
			this.read(chunk);
		});
		const close = () => {
			this.close(new Error('tmux control client closed'));
		};

		this.child.on('error', close);
		this.child.on('exit', close);
		this.child.stdin!.on('error', close);
		this.hold(false);
	}

	// An idle client is never the reason the process stays alive; one with a
	// reply outstanding is.
	private hold(busy: boolean): void {
		const handles = [this.child, this.child.stdout, this.child.stdin] as Array<{
			ref?: () => void;
			unref?: () => void;
		} | null>;
		for (const handle of handles) {
			if (busy) handle?.ref?.();
			else handle?.unref?.();
		}
	}

	get usable(): boolean {
		return !this.closed;
	}

	async run(command: string): Promise<string> {
		if (this.closed) throw new Error('tmux control client closed');
		return new Promise((resolve, reject) => {
			this.pending.push({resolve, reject, command, output: []});
			this.hold(true);
			this.child.stdin!.write(
				`${command} ; display-message -p ${quoteTmuxArgument(REPLY_END)}\n`,
			);
		});
	}

	stop(): void {
		this.close(new Error('tmux control client stopped'));
		this.child.kill();
	}

	private close(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const {reject} of this.pending.splice(0)) reject(reason);
		this.hold(false);
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const end = this.buffer.indexOf('\n');
			if (end === -1) return;
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			this.line(line);
		}
	}

	private line(line: string): void {
		if (this.block === undefined) {
			// Anything else outside a reply is a notification nobody asked for.
			const begin = /^%begin \d+ (\d+) \d+$/.exec(line);
			if (begin) {
				this.block = [];
				this.blockNumber = begin[1]!;
			}

			return;
		}

		// Output can itself start with `%`, as a pane id does, so only the
		// guard carrying this reply's number ends it.
		const end = /^%(end|error) \d+ (\d+) \d+$/.exec(line);
		if (end?.[2] !== this.blockNumber) {
			this.block.push(line);
			return;
		}

		const output = this.block;
		this.block = undefined;
		if (this.awaitingStart) {
			this.awaitingStart = false;
			if (end[1] === 'error') this.stop();
			return;
		}

		const reply = this.pending[0];
		if (!reply) return;
		const failed = end[1] === 'error';
		if (!failed && !(output.length === 1 && output[0] === REPLY_END)) {
			reply.output.push(...output);
			return;
		}

		this.pending.shift();
		if (this.pending.length === 0) this.hold(false);
		if (failed) reply.reject(commandError(reply.command, output.join('\n')));
		else
			reply.resolve(
				reply.output.length > 0 ? `${reply.output.join('\n')}\n` : '',
			);
	}
}
