import test from 'ava';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import type {UpdateInfo} from '../update-check.ts';
import UpdateBanner from './UpdateBanner.tsx';

const info: UpdateInfo = {installedVersion: '0.27.0', latestVersion: '9.9.9'};

test('a narrow banner wraps between words, never inside a version', async t => {
	for (let width = 18; width <= 40; width++) {
		let measured = 0;
		const view = await render(
			React.createElement(
				'box',
				{width},
				React.createElement(UpdateBanner, {
					info,
					onMeasure(height: number) {
						measured = height;
					},
				}),
			),
			{width, height: 10},
		);
		const frame = view.lastFrame();
		await view.unmount();
		for (const version of ['v0.27.0', 'v9.9.9']) {
			t.true(frame.includes(version), `${width} cols:\n${frame}`);
		}

		t.is(
			measured,
			frame.split('\n').length,
			`${width} cols, the reported footprint covers every wrapped line`,
		);
	}
});
