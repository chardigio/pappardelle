import {RGBA} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {chip, paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {describeSpace} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {paneWidths, TmuxWindow} from '../../kit/tmux.tsx';
import {callingCount, KitchenRail} from './Rail.tsx';
import {surfaces, tokens} from './tokens.ts';

const RAIL_COLS = 34;

function muted(look: Look, text: string): Seg {
	return look.tier === 'truecolor'
		? {text, fg: RGBA.fromHex(surfaces(look).muted)}
		: {text, dim: true};
}

export function KitchenChrome(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const [railCols, agentCols, companionCols] = paneWidths(width, RAIL_COLS);
	const body = height - 2;
	const calling = callingCount(frame.spaces.map(space => describeSpace(space)));
	const rule =
		look.tier === 'truecolor' ? RGBA.fromHex(surfaces(look).rule) : undefined;
	const top = Math.floor(body / 2) - 2;
	const placeholder: Seg[][] = [
		...Array.from({length: top}, () => []),
		[
			{text: ' '.repeat(Math.max(0, Math.floor((agentCols - 22) / 2)))},
			{text: 'NO COOK ON TICKET #381', bold: true},
		],
		[],
		[
			{text: ' '.repeat(Math.max(0, Math.floor((agentCols - 24) / 2)))},
			muted(look, 'fire it from the pass  ⏎'),
		],
	];
	return (
		<TmuxWindow
			cols={width}
			rows={height}
			border={{
				active: {text: '', fg: paint(tokens.heat, look), bold: true},
				inactive: rule ? {text: '', fg: rule} : {text: '', dim: true},
				horizontal: '═',
			}}
			status={[
				{text: ` 🍝 ${REPO} `, bold: true},
				muted(look, '═╤═'),
				calling > 0
					? {
							text: ` ${calling} CALLING `,
							...chip(
								paint(tokens.permission, look),
								paint(tokens.onAccent, look),
								look,
							),
							bold: true,
						}
					: muted(look, ' all quiet '),
				muted(look, '═╤═'),
				{text: '', grow: true},
				muted(look, 'ticket '),
				{text: '#381 ', bold: true},
			]}
			panes={[
				{
					width: railCols,
					active: true,
					title: [
						{text: ' THE PASS ', bold: true, fg: paint(tokens.heat, look)},
					],
					content: (
						<KitchenRail
							{...props}
							width={railCols}
							height={body}
							frame={{...frame, selected: 'PAP-381'}}
						/>
					),
				},
				{
					width: agentCols,
					active: false,
					title: [muted(look, ' LINE COOK · #381 ')],
					content: <Block cols={agentCols} rows={body} lines={placeholder} />,
				},
				{
					width: companionCols,
					active: false,
					title: [muted(look, ' EXPO · gitui ')],
					content: <Block cols={companionCols} rows={body} lines={[]} />,
				},
			]}
		/>
	);
}

export function kitchenTmuxConf(): string {
	return `# Kitchen pass: the rail is the pass, panes are stations.
set -w pane-border-lines double
set -w pane-border-status top
set -w pane-border-format ' #{pane_title} '
set -w pane-border-style 'fg=default,dim'
set -w pane-active-border-style 'fg=yellow,bold'
set -g status-style 'bg=default,fg=default'
set -g status-left ' 🍝 #S ═╤═ '
# Needs new plumbing: pappardelle sets @pappardelle_calling on change.
set -g status-right '#{?#{@pappardelle_calling},#[reverse] #{@pappardelle_calling} CALLING #[noreverse],}'`;
}
