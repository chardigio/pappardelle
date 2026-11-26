import {Buffer} from 'node:buffer';
import {test, expect} from 'bun:test';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {until} from '../../test/helpers/wait.ts';
import ConfirmDialog from './ConfirmDialog.tsx';

// STA-1373: closing a space runs synchronous setup before its first await, so
// the spinner has to be on screen before onConfirm starts or the dialog looks
// frozen for the length of that work.
test('the processing spinner is presented before onConfirm runs', async () => {
	let frameAtConfirm: string | undefined;
	const view = await render(
		React.createElement(ConfirmDialog, {
			title: 'Close space',
			message: 'Close PAP-1?',
			processingMessage: 'Closing space PAP-1…',
			isDestructive: true,
			async onConfirm() {
				frameAtConfirm = view.lastFrame();
				const end = Date.now() + 300;
				while (Date.now() < end) {
					// Stands in for execSync and file reads before the first await.
				}
			},
			onCancel() {},
		}),
	);
	view.renderer.stdin.emit('data', Buffer.from('y'));
	await until(() => frameAtConfirm !== undefined);
	expect(frameAtConfirm!).toMatch(/Closing space PAP-1…/);
});
