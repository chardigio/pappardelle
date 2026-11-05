import SpaceListItem from '../../../source/components/SpaceListItem.tsx';
import HelpOverlay from '../../../source/components/HelpOverlay.tsx';
import ErrorDialog from '../../../source/components/ErrorDialog.tsx';
import ConfirmDialog from '../../../source/components/ConfirmDialog.tsx';
import {terminalColor, textAttributes} from '../../../source/tui-style.ts';
import {REPO} from '../../fixtures.ts';
import {
	sampleErrors,
	type ConfirmProps,
	type SurfaceProps,
} from '../../kit/surface.ts';

const noop = () => {};

/**
 * PR !58 as it renders today, fed the design fixtures so "before" and
 * "after" frames show the same fleet. Rows and popups are the real
 * components; the header mirrors the JSX in source/app.tsx, which renders it
 * inline rather than as a component.
 */
export function CurrentRail({width, height, layout, frame}: SurfaceProps) {
	const spaceCount = frame.spaces.filter(space => !space.isPending).length;
	const dim = textAttributes({dim: true});
	return (
		<box flexDirection="column" width={width} height={height}>
			<box flexDirection="row" height={1} overflow="hidden">
				<text
					attributes={textAttributes({bold: true})}
					fg={terminalColor('cyan')}
					wrapMode="none"
				>
					🍝 {REPO}
				</text>
				<text attributes={dim} fg={terminalColor()} wrapMode="none">
					{' | '}
					{spaceCount} spaces
				</text>
			</box>
			<box height={1} />
			<box flexDirection="column">
				{frame.spaces.map(space => (
					<SpaceListItem
						key={space.name || 'new'}
						space={space}
						isSelected={space.name === frame.selected}
						width={width}
						layout={layout}
					/>
				))}
			</box>
		</box>
	);
}

export function CurrentHelp({height}: SurfaceProps) {
	return (
		<HelpOverlay
			isFullHeight
			onClose={noop}
			commitSha="7066cdb"
			installedVersion="0.8.0"
			availableHeight={height}
		/>
	);
}

export function CurrentErrors(_props: SurfaceProps) {
	return (
		<ErrorDialog
			isFullHeight
			errors={sampleErrors}
			onClose={noop}
			onClear={noop}
		/>
	);
}

export function CurrentConfirm({destructive}: ConfirmProps) {
	return destructive ? (
		<ConfirmDialog
			title="Close Space"
			message="Close space PAP-390?"
			detail="The worktree and git branch will remain on disk."
			onConfirm={noop}
			onCancel={noop}
		/>
	) : (
		<ConfirmDialog
			title="Update Pappardelle"
			message="Update from v0.8.0 to v0.9.0?"
			detail="Downloads and runs the installer, then restarts Pappardelle."
			onConfirm={noop}
			onCancel={noop}
		/>
	);
}
