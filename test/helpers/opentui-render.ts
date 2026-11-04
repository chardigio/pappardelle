import {Buffer} from 'node:buffer';
import type {ReactNode} from 'react';
import {createRoot, flushSync} from '@opentui/react';
import {createTestRenderer} from '@opentui/core/testing';
import {preferGraphemeWidths} from '../../source/render-tui.ts';
/** Component tests use OpenTUI's real offscreen renderer and input parser. */
export async function render(
	node: ReactNode,
	options: {width?: number; height?: number} = {},
) {
	preferGraphemeWidths();
	const setup = await createTestRenderer({width: 100, height: 80, ...options});
	let frame = '';
	const captureFrame = () => {
		const children = setup.renderer.root.getChildren();
		const height = Math.max(
			1,
			...children.map(child => child.y + child.height),
		);
		frame = setup
			.captureCharFrame()
			.split('\n')
			.slice(0, height)
			.map(line => line.trimEnd())
			.join('\n');
	};
	// Frame events run after native presentation releases the output buffer.
	// Keep the last completed frame, just as a terminal displays it, rather
	// than acquiring the buffer while a subsequent async frame is in flight.
	setup.renderer.on('frame', captureFrame);
	const root = createRoot(setup.renderer);
	const dispose = async () => {
		await setup.dispose();
	};
	const rerender = async (next: ReactNode) => {
		flushSync(() => root.render(next));
		await setup.renderOnce();
	};
	await rerender(node);
	return {
		...setup,
		rerender,
		lastFrame: () => frame,
		stdin: {
			async write(data: string) {
				setup.renderer.stdin.emit('data', Buffer.from(data));
				await new Promise(resolve => {
					setImmediate(resolve);
				});
				flushSync(() => {});
				await setup.renderOnce();
			},
		},
		unmount: dispose,
	};
}
