import type {ReactNode} from 'react';
import type {SceneFrame} from '../fixtures.ts';
import {
	SURFACES,
	type Direction,
	type SurfaceName,
	type SurfaceProps,
} from '../kit/surface.ts';
import {
	CurrentConfirm,
	CurrentErrors,
	CurrentHelp,
	CurrentRail,
} from './current/index.tsx';
import {quietCraft} from './quiet-craft/index.tsx';
import {kitchenPass} from './kitchen-pass/index.tsx';
import {livingRail} from './living-rail/index.tsx';
import {missionControl} from './mission-control/index.tsx';

export const directions: Direction[] = [
	quietCraft,
	kitchenPass,
	livingRail,
	missionControl,
];

export type Target = {
	id: string;
	name: string;
	surfaces: SurfaceName[];
	render(surface: SurfaceName, props: SurfaceProps): ReactNode;
	/** Frame rate the surface needs right now; undefined when nothing moves. */
	fps(surface: SurfaceName, props: SurfaceProps): number | undefined;
	/** Row names in the order the rail shows them, for j/k. */
	order(frame: SceneFrame): string[];
};

const current: Target = {
	id: 'current',
	name: 'Current (PR !58)',
	surfaces: ['rail', 'confirm', 'confirm-neutral', 'help', 'errors'],
	render(surface, props) {
		if (surface === 'rail') return <CurrentRail {...props} />;
		if (surface === 'help') return <CurrentHelp {...props} />;
		if (surface === 'errors') return <CurrentErrors {...props} />;
		if (surface === 'confirm') return <CurrentConfirm {...props} destructive />;
		if (surface === 'confirm-neutral')
			return <CurrentConfirm {...props} destructive={false} />;
		return null;
	},
	fps: () => undefined,
	order: frame => frame.spaces.map(space => space.name),
};

function fromDirection(direction: Direction): Target {
	return {
		id: direction.id,
		name: direction.name,
		surfaces: SURFACES,
		render(surface, props) {
			switch (surface) {
				case 'rail': {
					return <direction.Rail {...props} />;
				}

				case 'prompt': {
					return <direction.Prompt {...props} />;
				}

				case 'confirm': {
					return <direction.Confirm {...props} destructive />;
				}

				case 'confirm-neutral': {
					return <direction.Confirm {...props} destructive={false} />;
				}

				case 'help': {
					return <direction.Help {...props} />;
				}

				case 'errors': {
					return <direction.Errors {...props} />;
				}

				case 'chrome': {
					return <direction.Chrome {...props} />;
				}
			}
		},
		fps(surface, props) {
			return surface === 'rail' || surface === 'chrome'
				? direction.fps(props)
				: direction.dialogFps?.(surface, props);
		},
		order: frame =>
			direction.order?.(frame) ?? frame.spaces.map(space => space.name),
	};
}

export const targets: Target[] = [
	current,
	...directions.map(direction => fromDirection(direction)),
];

export function targetById(id: string): Target {
	const target = targets.find(t => t.id === id);
	if (!target)
		throw new Error(
			`Unknown direction "${id}". Known: ${targets.map(t => t.id).join(', ')}`,
		);
	return target;
}
