import {RGBA} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {needYou, describeSpace} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {paneWidths, TmuxWindow} from '../../kit/tmux.tsx';
import {counts, QuietRail} from './Rail.tsx';
import {surfaces, tokens} from './tokens.ts';

const RAIL_COLS = 34;

function muted(look: Look, text: string): Seg {
	return look.tier === 'truecolor'
		? {text, fg: RGBA.fromHex(surfaces(look).muted)}
		: {text, dim: true};
}

/** Replaces the bare `printf "No session for X"` in the agent pane. */
function AgentPlaceholder({
	look,
	cols,
	rows,
}: {
	look: Look;
	cols: number;
	rows: number;
}) {
	const top = Math.floor(rows / 2) - 2;
	const center = (segs: Seg[], cells: number): Seg[] => [
		{text: ' '.repeat(Math.max(0, Math.floor((cols - cells) / 2)))},
		...segs,
	];
	return (
		<Block
			cols={cols}
			rows={rows}
			lines={[
				...Array.from({length: top}, () => []),
				center(
					[{text: 'PAP-381', bold: true}, muted(look, ' has no agent running')],
					29,
				),
				[],
				center(
					[
						{text: ' ⏎ ', inverse: true, bold: true},
						muted(look, ' in the rail starts one'),
					],
					26,
				),
			]}
		/>
	);
}

export function QuietChrome(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const [railCols, agentCols, companionCols] = paneWidths(width, RAIL_COLS);
	const body = height - 2;
	const {needsYou, working} = counts(
		frame.spaces.map(space => describeSpace(space)),
	);
	const hairline =
		look.tier === 'truecolor'
			? RGBA.fromHex(surfaces(look).hairline)
			: undefined;
	const inactive: Seg = hairline
		? {text: '', fg: hairline}
		: {text: '', dim: true};
	const status: Seg[] = [
		{text: ` ${REPO}`, bold: true},
		{text: ' ', grow: true},
		{text: `◆ ${needYou(needsYou)}`, fg: paint(tokens.question, look)},
		muted(look, `   ◴ ${working} working   `),
		muted(look, 'PAP-381 '),
	];
	return (
		<TmuxWindow
			cols={width}
			rows={height}
			border={{active: {text: ''}, inactive, horizontal: '─'}}
			status={status}
			panes={[
				{
					width: railCols,
					active: true,
					title: [{text: ' rail ', bold: true}],
					content: (
						<QuietRail
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
					title: [muted(look, ' agent · PAP-381 ')],
					content: (
						<AgentPlaceholder look={look} cols={agentCols} rows={body} />
					),
				},
				{
					width: companionCols,
					active: false,
					title: [muted(look, ' gitui ')],
					content: <Block cols={companionCols} rows={body} lines={[]} />,
				},
			]}
		/>
	);
}

export function quietTmuxConf(): string {
	return `# Quiet craft: borders recede, titles say what each pane is.
set -w pane-border-lines single
set -w pane-border-status top
set -w pane-border-format ' #{pane_title} '
set -w pane-border-style 'fg=default,dim'
set -w pane-active-border-style 'fg=default'
set -g status-style 'bg=default,fg=default'
set -g status-left ' #S '
# Needs new plumbing: pappardelle writes a summary into a user option
# whenever the fleet changes, so tmux never shells out to render it.
set -g status-right '#{@pappardelle_summary} '`;
}
