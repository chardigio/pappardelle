import {test, expect} from 'bun:test';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import TitledBox from './TitledBox.tsx';

const box = (borderStyle: 'double' | 'round') =>
	React.createElement(
		TitledBox,
		{
			title: 'Profile',
			borderColor: 'cyan',
			titleColor: 'yellow',
			borderStyle,
			paddingY: 0,
		},
		React.createElement('text', null, 'row one'),
	);

test('changing focus borders preserves the content directly below the title', async () => {
	const view = await render(box('round'));
	for (const style of ['round', 'double', 'round'] as const) {
		await view.rerender(box(style));
		const lines = (view.lastFrame() ?? '').split('\n');
		expect(lines.length).toBe(3);
		expect(lines[0]!.includes('Profile')).toBe(true);
		expect(lines[1]!.includes('row one')).toBe(true);
	}
	await view.unmount();
});
