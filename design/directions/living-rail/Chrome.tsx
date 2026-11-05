import {RGBA} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {chip, paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {cycle, sparkline} from '../../kit/motion.ts';
import {focusRow, needYou, describeSpace} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {paneWidths, TmuxWindow} from '../../kit/tmux.tsx';
import {fleetActivity, LivingRail} from './Rail.tsx';
import {surfaces, tokens} from './tokens.ts';

const RAIL_COLS = 34;
const FOCUSED = 'PAP-409';

function muted(look: Look, text: string): Seg {
	return look.tier === 'truecolor'
		? {text, fg: RGBA.fromHex(surfaces(look).muted)}
		: {text, dim: true};
}

export function LivingChrome(props: SurfaceProps) {
	const {look, now, width, height, frame} = props;
	const [railCols, agentCols, companionCols] = paneWidths(width, RAIL_COLS);
	const body = height - 2;
	const rows = frame.spaces.map(space => describeSpace(space));
	const focused = focusRow(rows, FOCUSED);
	const needsYou = rows.filter(row => row.needsYou).length;
	const accent = paint(focused.needsYou ? tokens.question : tokens.live, look);
	// The agent pane's border takes the focused agent's state color, so you
	// can tell it is waiting on you without looking at the rail.
	// The pane shows a question when the focused agent is asking one; any
	// other focus just names the agent and what it last said.
	const agentLines: Seg[][] = focused.needsYou
		? [
				[],
				[
					{text: '  '},
					{text: '●', fg: accent, bold: true},
					{text: ` ${focused.key} is asking:`, bold: true},
				],
				[],
				[{text: '    Which test runner should the resize test use?'}],
				[],
				[muted(look, '    1. ava, like the rest of source/')],
				[muted(look, '    2. bun test')],
				[],
				[
					muted(
						look,
						`  ${cycle(['·  ', '·· ', '···', ' ··', '  ·', '   '], now, 220)} waiting for you`,
					),
				],
			]
		: [
				[],
				[
					{text: '  '},
					{text: '●', fg: accent, bold: true},
					{text: ` ${focused.key}`, bold: true},
				],
				[],
				[muted(look, `    ${focused.detail ?? focused.state}`)],
			];
	return (
		<TmuxWindow
			cols={width}
			rows={height}
			border={{
				active: {text: '', fg: accent, bold: true},
				inactive: muted(look, ''),
				horizontal: '─',
			}}
			status={[
				{text: ` ${REPO} `, bold: true},
				{text: sparkline(fleetActivity(rows)), fg: paint(tokens.live, look)},
				{text: '', grow: true},
				...(needsYou > 0
					? [
							{
								text: ` ${needYou(needsYou)} `,
								...chip(
									paint(tokens.question, look),
									paint(tokens.onAccent, look),
									look,
								),
								bold: true,
							},
						]
					: []),
				{text: '  '},
				{text: 'PAP-409 ', bold: true},
			]}
			panes={[
				{
					width: railCols,
					active: false,
					title: [muted(look, ' rail ')],
					content: (
						<LivingRail
							{...props}
							width={railCols}
							height={body}
							frame={{...frame, selected: focused.space.name}}
						/>
					),
				},
				{
					width: agentCols,
					active: true,
					title: [
						{
							text: ` ● ${focused.key} · ${focused.needsYou ? 'needs you' : focused.state} `,
							fg: accent,
							bold: true,
						},
					],
					content: <Block cols={agentCols} rows={body} lines={agentLines} />,
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

export function livingTmuxConf(): string {
	return `# Living rail: borders follow the focused agent's state.
set -w pane-border-lines single
set -w pane-border-status top
set -w pane-border-format ' #{?#{@agent_state},● ,}#{pane_title} '
set -w pane-border-style 'fg=default,dim'
# Needs new plumbing: pappardelle updates these per window as agents change.
set -w pane-active-border-style '#{?#{==:#{@agent_state},blocked},fg=blue,fg=cyan}'
set -g status-right '#{@pappardelle_activity} #{?#{@pappardelle_needs_you},#[reverse] #{@pappardelle_needs_you} #{?#{==:#{@pappardelle_needs_you},1},needs,need} you #[noreverse],}'`;
}
