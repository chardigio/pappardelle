import {RGBA} from '@opentui/core';
import {REPO} from '../../fixtures.ts';
import {paint, type Look} from '../../kit/color.ts';
import {Block, type Seg} from '../../kit/line.tsx';
import {age, focusRow, describeSpace} from '../../kit/row.ts';
import type {SurfaceProps} from '../../kit/surface.ts';
import {paneWidths, TmuxWindow} from '../../kit/tmux.tsx';
import {channelColor, fleetCounts, MissionRail, muted} from './Rail.tsx';
import {READOUT, surfaces, tokens} from './tokens.ts';

const RAIL_COLS = 34;
const FOCUSED = 'PAP-409';

function grid(look: Look): Seg {
	return look.tier === 'truecolor'
		? {text: '', fg: RGBA.fromHex(surfaces(look).grid)}
		: {text: '', dim: true};
}

export function MissionChrome(props: SurfaceProps) {
	const {look, width, height, frame} = props;
	const [railCols, agentCols, companionCols] = paneWidths(width, RAIL_COLS);
	const body = height - 2;
	const rows = frame.spaces.map(space => describeSpace(space));
	const {run, ask, err} = fleetCounts(rows);
	const focused = focusRow(rows, FOCUSED);
	const {code} = READOUT[focused.state];
	const caution = paint(tokens.caution, look);
	// The agent pane and its label take the focused agent's signal color.
	const focus = channelColor(READOUT[focused.state].channel, look);
	const status = focused.space.programStatus;
	const telemetry: Seg[][] = [
		[],
		[
			muted(look, '  SOURCE   '),
			{
				text: [status?.source, status?.tool ?? focused.app]
					.filter(Boolean)
					.join(' · '),
			},
		],
		[
			muted(look, '  STATE    '),
			{
				text: code,
				bold: true,
				fg: channelColor(READOUT[focused.state].channel, look),
			},
		],
		[
			muted(look, '  T+       '),
			{
				text:
					focused.stateSince === undefined
						? '—'
						: age(props.now - focused.stateSince),
			},
		],
		[],
		[
			muted(
				look,
				`  The agent pane would show ${focused.key}${focused.detail ? `: ${focused.detail}` : ''}`,
				{shrink: true},
			),
		],
	];
	return (
		<TmuxWindow
			cols={width}
			rows={height}
			border={{
				active: {text: '', fg: focus, bold: true},
				inactive: grid(look),
				horizontal: '━',
				vertical: '┃',
				junction: '┳',
			}}
			status={[
				{text: ' ▣ ', fg: paint(tokens.live, look)},
				{text: `${REPO.toUpperCase()} `, bold: true},
				muted(look, '│ '),
				{text: `RUN ${run} `, fg: paint(tokens.live, look)},
				{text: `ASK ${ask} `, fg: caution, bold: ask > 0},
				{text: `ERR ${err} `, fg: paint(tokens.warning, look), bold: err > 0},
				{text: '', grow: true},
				muted(look, 'FOCUS '),
				{text: `${focused.key} ${code} `, fg: focus, bold: true},
			]}
			panes={[
				{
					width: railCols,
					active: false,
					title: [muted(look, '[ RAIL ]')],
					content: (
						<MissionRail
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
							text: `[ AGENT · ${focused.key} · ${code} ]`,
							fg: focus,
							bold: true,
						},
					],
					content: <Block cols={agentCols} rows={body} lines={telemetry} />,
				},
				{
					width: companionCols,
					active: false,
					title: [muted(look, '[ AUX · gitui ]')],
					content: <Block cols={companionCols} rows={body} lines={[]} />,
				},
			]}
		/>
	);
}

export function missionTmuxConf(): string {
	return `# Mission control: heavy frames, bracketed pane labels, a fleet readout.
set -w pane-border-lines heavy
set -w pane-border-status top
set -w pane-border-format '[ #{pane_title} ]'
set -w pane-border-style 'fg=default,dim'
# Needs new plumbing: pappardelle sets @agent_state per pane as agents change.
set -w pane-active-border-style '#{?#{==:#{@agent_state},blocked},fg=yellow,#{?#{==:#{@agent_state},error},fg=red,fg=cyan}},bold'
set -g status-style 'bg=default,fg=default'
set -g status-left ' ▣ #{=12:session_name} │ '
# Needs new plumbing: pappardelle writes RUN/ASK/ERR counts on change.
set -g status-right '#{@pappardelle_fleet} '`;
}
