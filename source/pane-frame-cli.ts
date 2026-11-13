import {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {
	BoxRenderable,
	createCliRenderer,
	EmbeddedTerminalRenderable,
	type OptimizedBuffer,
} from '@opentui/core';
import {paintFrame} from './components/frame-paint.ts';
import {routeDrops} from './drop-routing.ts';
import {FrameInputRouter} from './frame-input.ts';
import {interceptInput} from './lone-escape.ts';
import {FramedOutput, GraphicsForwarder} from './pane-frame-graphics.ts';
import {OscScanner, type SizeQuery} from './pane-frame-osc.ts';
import {paletteSequences, queryPalette} from './pane-frame-palette.ts';
import {
	CLIENT_TTY_OPTION,
	FRAME_COMMAND_OPTION,
	PANE_TITLE_OPTION,
	frameReadyChannel,
	frameStartedChannel,
} from './pane-frame-options.ts';

// Draws a rounded, titled frame in a viewer pane and runs the pane's command
// (a nested `tmux attach`, or a message) inside it. tmux can only draw the
// dividers between panes, so the frame has to come from the pane itself.

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const command = separator === -1 ? [] : args.slice(separator + 1);
// Started with its pane, before the rail knows what the pane will show.
const awaitsCommand = args.includes('--await');
const titleFlag = args.indexOf('--title');
const outerSocket = (process.env['TMUX'] ?? '').split(',')[0] ?? '';
const paneId = process.env['TMUX_PANE'] ?? '';

function outerTmux(tmuxArgs: string[]): string {
	if (!outerSocket || !paneId) return '';
	const result = spawnSync('tmux', ['-S', outerSocket, ...tmuxArgs], {
		encoding: 'utf8',
	});
	return result.status === 0 ? result.stdout.trim() : '';
}

let title =
	titleFlag !== -1 && (separator === -1 || titleFlag < separator)
		? (args[titleFlag + 1] ?? '')
		: outerTmux([
				'display-message',
				'-p',
				'-t',
				paneId,
				`#{${PANE_TITLE_OPTION}}`,
			]);
let isActive =
	outerTmux(['display-message', '-p', '-t', paneId, '#{pane_active}']) === '1';

// Everything a pane's program draws waits for this renderer's next frame, so
// the cap is twice the default 60.
const renderer = await createCliRenderer({
	exitOnCtrlC: false,
	exitSignals: [],
	maxFps: 120,
});
const frame = new BoxRenderable(renderer, {
	id: 'frame',
	width: '100%',
	height: '100%',
	border: true,
	borderStyle: 'rounded',
	renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
		paintFrame(this, buffer, {
			title,
			style: 'rounded',
			isDim: !isActive,
			inset: 1,
		});
	},
});
renderer.root.add(frame);

// Filled once the child starts; the terminal's callbacks need it first.
const childPty: {current?: Bun.Terminal} = {};
const childSize = {
	cols: Math.max(1, renderer.width - 2),
	rows: Math.max(1, renderer.height - 2),
};
const terminal = new EmbeddedTerminalRenderable(renderer, {
	id: 'terminal',
	width: '100%',
	height: '100%',
	// Until its first layout the terminal would otherwise be 80x24, and a
	// program that drew at the pane's real size before then is not asked to
	// draw again.
	...childSize,
	maxScrollback: 0,
	transparentBackground: true,
	selectable: false,
	onData(data) {
		childPty.current?.write(data);
	},
	onTerminalResize(cols, rows) {
		childSize.cols = cols;
		childSize.rows = rows;
		childPty.current?.resize(cols, rows);
	},
});
// The renderer's own output queue keeps graphics in order with its frames,
// which go out in the same queue.
const rendererOutput = (
	renderer as unknown as {nativeSession?: {write(bytes: Uint8Array): boolean}}
).nativeSession;
const encoder = new TextEncoder();
const graphics = new GraphicsForwarder(sequence => {
	if (rendererOutput) return rendererOutput.write(encoder.encode(sequence));
	process.stdout.write(sequence);
	return true;
}, Boolean(outerSocket));
const framedOutput = new FramedOutput({
	writeScreen(bytes) {
		terminal.write(bytes);
	},
	writeGraphics: command => graphics.forward(command),
	requestFrame() {
		renderer.requestRender();
	},
	schedule(callback, ms) {
		const timer = setTimeout(callback, ms);
		return () => {
			clearTimeout(timer);
		};
	},
});
renderer.setFrameCallback(async () => {
	framedOutput.flushFrame();
});
// Keys go to the program as the bytes tmux wrote, without passing through
// the renderer's input parser; see FrameInputRouter. Until the program has
// started, everything read is the terminal answering the renderer.
const inputRouter = new FrameInputRouter();
let heldInput: ReturnType<typeof setTimeout> | undefined;
interceptInput(renderer, process.stdin, (chunk, parse) => {
	graphics.readReplies(
		typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'),
	);
	if (!childPty.current || typeof chunk === 'string') {
		parse(chunk);
		return;
	}

	clearTimeout(heldInput);
	for (const segment of inputRouter.route(chunk)) {
		if (segment.to === 'program') childPty.current.write(segment.bytes);
		else parse(Buffer.from(segment.bytes));
	}

	// The rest of a sequence the read ended in arrives at once if it is coming.
	if (inputRouter.isHolding)
		heldInput = setTimeout(() => {
			const held = inputRouter.release();
			if (held) childPty.current?.write(held);
		}, 3);
});
// The terminal a paste came from has already made it safe to paste. The
// embedded terminal's own encoding would replace Escape, Ctrl+C and Delete in
// it with spaces, so only its bracketing is used: what it puts around a
// single letter says whether the program asked for bracketed paste.
terminal.handlePaste = event => {
	const marker = 0x78;
	const framed = terminal.encodePaste(Uint8Array.of(marker));
	const at = framed.indexOf(marker);
	childPty.current?.write(
		Buffer.concat([
			framed.subarray(0, at),
			event.bytes,
			framed.subarray(at + 1),
		]),
	);
};
frame.add(terminal);
terminal.focus();

renderer.on('focus', () => {
	graphics.probe();
	isActive = true;
	renderer.requestRender();
});
renderer.on('blur', () => {
	isActive = false;
	renderer.requestRender();
});
if (outerSocket && paneId)
	routeDrops(renderer, {socket: outerSocket, paneId, isFocused: isActive});

graphics.probe();

// Loaded before the child starts so its first output is already in the
// user's colors, and again whenever the terminal switches theme.
const palette = await queryPalette(
	{
		write(sequence) {
			process.stdout.write(sequence);
		},
		subscribeOsc: handler => renderer.subscribeOsc(handler),
		prependInputHandler(handler) {
			renderer.prependInputHandler(handler);
		},
		removeInputHandler(handler) {
			renderer.removeInputHandler(handler);
		},
	},
	500,
);
terminal.write(paletteSequences(palette));
renderer.on('palette', (colors: Parameters<typeof paletteSequences>[0]) => {
	terminal.write(paletteSequences(colors));
	terminal.invalidate();
	renderer.requestRender();
});

// Bun's pty carries no pixel size, so the nested tmux client asks for it, and
// while that query is unanswered tmux holds every lone Escape for 500ms
// waiting to see whether it starts the reply.
function sizeReply(query: SizeQuery): string {
	const {cols, rows} = childSize;
	if (query === 'cells') return `\u001B[8;${rows};${cols}t`;
	const {resolution} = renderer;
	const cellWidth = resolution ? resolution.width / renderer.width : 0;
	const cellHeight = resolution ? resolution.height / renderer.height : 0;
	return `\u001B[4;${Math.round(cellHeight * rows)};${Math.round(cellWidth * cols)}t`;
}

// The program's keypad mode was passed on to this pane, and a program that is
// killed does not take it back.
function leaveKeypadMode(): void {
	process.stdout.write('\u001B>');
}

const scanner = new OscScanner();
const childEnv: Record<string, string | undefined> = {
	...process.env,
	TERM: 'xterm-256color',
	COLORTERM: 'truecolor',
};
delete childEnv['TMUX'];
delete childEnv['TMUX_PANE'];

// The rail moves this pane's nested tmux client between sessions by its tty,
// which only the child can see, so the child publishes it before starting and
// signals the rail, which is waiting for it. A child without a program yet
// waits for the rail's signal first, so that its tty still appears only once
// the program is about to run.
const child = Bun.spawn(
	awaitsCommand
		? [
				'/bin/sh',
				'-c',
				't=$(tty); tmux -S "$1" wait-for "$5" && exec /bin/sh -c "$(tmux -S "$1" set-option -p -t "$2" "$3" "$t" \\; wait-for -S "$6" \\; show-option -pqv -t "$2" "$4")"',
				'sh',
				outerSocket,
				paneId,
				CLIENT_TTY_OPTION,
				FRAME_COMMAND_OPTION,
				frameReadyChannel(paneId),
				frameStartedChannel(paneId),
			]
		: [
				'/bin/sh',
				'-c',
				'[ -n "$1" ] && tmux -S "$1" set-option -p -t "$2" "$3" "$(tty)" \\; wait-for -S "$4" 2>/dev/null; shift 4; exec "$@"',
				'sh',
				outerSocket,
				paneId,
				CLIENT_TTY_OPTION,
				frameStartedChannel(paneId),
				...command,
			],
	{
		env: childEnv,
		terminal: {
			...childSize,
			data(childTerminal, data) {
				const events = scanner.feed(data);
				if (events.title !== undefined && events.title !== title) {
					title = events.title;
					renderer.requestRender();
				}

				for (const sequence of events.passthrough)
					process.stdout.write(sequence);
				for (const query of events.sizeQueries)
					childTerminal.write(sizeReply(query));
				framedOutput.receive(events.output);
			},
		},
	},
);

// The child runs in its own pty, so closing or respawning the pane signals
// only this process. Without passing it on, the nested client would keep this
// process waiting forever.
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		child.kill(signal);
		leaveKeypadMode();
		renderer.destroy();
		process.exit(0);
	});
}

childPty.current = child.terminal;
process.exitCode = await child.exited;
leaveKeypadMode();
renderer.destroy();
