import test from 'ava';
import React from 'react';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import TitledBox from './TitledBox.tsx';

const box = (borderStyle: 'double' | 'round') =>
	React.createElement(
		TitledBox,
		{
			title: 'Profile',
			width: 40,
			borderColor: 'cyan',
			titleColor: 'yellow',
			borderStyle,
			paddingY: 0,
		},
		React.createElement(Text, null, 'row one'),
	);

test('changing focus borders preserves the content directly below the title', t => {
	const view = render(box('round'));
	for (const style of ['round', 'double', 'round'] as const) {
		view.rerender(box(style));
		const lines = (view.lastFrame() ?? '').split('\n');
		t.is(lines.length, 3);
		t.true(lines[0]!.includes('Profile'));
		t.true(lines[1]!.includes('row one'));
	}
	view.unmount();
});
