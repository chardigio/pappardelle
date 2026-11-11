"""Plot one actual sample, not a composite timeline.

Run: uv run --with matplotlib python -P scripts/benchmarks/startup-waterfall.py
The safe-path flag prevents the adjacent packaging.py from shadowing packaging.
"""
import argparse
import json
from pathlib import Path
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', type=Path, default=root / 'docs/workspace-startup-waterfall-trace.json')
parser.add_argument('--output-prefix', type=Path, default=root / 'docs/workspace-startup-waterfall')
args = parser.parse_args()
data = json.loads(args.input.read_text())
samples = next(iter(data['samples'].values()))
sample = sorted(samples, key=lambda s: s['milestones']['requiredVisibleMs'])[len(samples) // 2]
records = [(event, json.loads(event['message'].split('[startup] ')[1]))
           for event in sample['logEvents'] if '[startup] {' in event['message']]
offset = statistics.median(event['elapsedMs'] - record['elapsedMs'] for event, record in records)
begins = {record['id']: record for _, record in records if record['phase'] == 'begin'}
spans = {}
for _, record in records:
    if record['phase'] == 'end' and record['id'] in begins:
        spans.setdefault(record['stage'], []).append((begins[record['id']]['elapsedMs'] + offset, record['elapsedMs'] + offset))

bootstrap = next(r for _, r in records if r['stage'] == 'unattributed-bootstrap')
rows = []
def row(label, start, end, kind='work'):
    rows.append((label, start, end, kind))
def stage(label, name, index=0, kind='work'):
    row(label, *spans[name][index], kind)

row('Harness launch → process clock (approx.)', 0, offset, 'unknown')
row('Executable / imports — not attributed', offset, offset + bootstrap['elapsedMs'], 'unknown')
row('Configuration + repository bootstrap', spans['configuration'][0][0], spans['repo-bootstrap'][0][1])
row('Cleanup + migration + reaping', spans['outer-cleanup'][0][0], spans['inner-reaping'][0][1])
stage('Create outer panes + configure tmux', 'layout-setup')
row('Commit + version metadata', spans['commit-metadata'][0][0], spans['version-metadata'][0][1])
if 'renderer-imports' in spans:
    stage('Load renderer + application modules', 'renderer-imports')
stage('Initialize renderer', 'renderer')
row('Uninstrumented: renderer → first layout request', spans['renderer'][0][1], spans['layout-request'][0][0], 'unknown')
stage('Main workspace discovery (overlaps layout)', 'main-discovery', kind='parallel')
stage('First layout pass', 'layout-pass')
row('Uninstrumented: next request → pass starts', spans['layout-request'][1][0], spans['layout-pass'][1][0], 'unknown')
stage('Final layout pass', 'layout-pass', 1)
stage('Prepare agent session (includes monitor)', 'agent-session', kind='parallel')
stage('Prepare companion session (parallel)', 'companion-session', kind='parallel')
stage('Install status monitor (nested in agent)', 'monitor-ready', kind='nested')
stage('Attach viewers / finish attachment', 'viewer-attachment')
m = sample['milestones']
for label, key in [('Rail observed', 'railVisibleMs'), ('Dummy agent ready', 'agentReadyMs'), ('Both viewers observed', 'requiredVisibleMs')]:
    row(label, m[key], m[key], 'milestone')

colors = dict(work='#2563eb', parallel='#0f766e', nested='#9333ea', unknown='#94a3b8', milestone='#c2410c')
fig, ax = plt.subplots(figsize=(14, 10))
for y, (label, start, end, kind) in enumerate(rows):
    if kind == 'milestone':
        ax.scatter(start, y, marker='D', color=colors[kind], s=45, zorder=3)
        text = f'{start:.1f} ms'
    else:
        ax.barh(y, end-start, left=start, height=.62, color=colors[kind])
        text = f'{end-start:.1f} ms'
    ax.text(end+2, y, text, va='center', fontsize=9)
ax.set_yticks(range(len(rows)), [r[0] for r in rows], fontsize=10)
ax.invert_yaxis()
limit = int(max(r[2] for r in rows) / 25 + 2) * 25
ax.set_xlim(0, limit)
ax.set_xticks(range(0, limit + 1, 25))
ax.set_xlabel('Milliseconds since benchmark launch; overlapping bars must not be added')
ax.grid(axis='x', alpha=.2)
ax.set_axisbelow(True)
ax.spines[['top', 'right', 'left']].set_visible(False)
ax.set_title('Where startup time goes — one actual launch', loc='left', fontsize=16, pad=35)
ax.text(0, 1.025, 'Linux · 100 columns · main + 3 workspaces · fresh sessions · dummy agents · native tmux', transform=ax.transAxes, fontsize=10)
ax.legend(handles=[Patch(color=colors[k], label=v) for k,v in [('work','Measured span'),('parallel','Overlapping work'),('nested','Nested span'),('unknown','Unattributed interval')]], loc='lower center', bbox_to_anchor=(.42,-.16), ncol=4, frameon=False)
sha = next(iter(data['environment']['executables'].values()))['binarySha256'][:8]
fig.text(.02,.025, f'SHA {sha} · median-visible sample of {len(samples)} (not a composite of medians). Log-clock alignment offset ≈ {offset:.1f} ms.\nVisibility sampled every 20 ms + subprocess overhead; spans measure elapsed wait, not CPU time. Trace quiet timer excluded.', fontsize=9, color='#475569')
fig.subplots_adjust(left=.38, right=.96, top=.88, bottom=.16)
for extension in ('png','svg'):
    fig.savefig(args.output_prefix.with_suffix('.' + extension), dpi=160)
summary = dict(offsetMs=offset, milestones=m, rows=[dict(label=l,startMs=s,endMs=e,kind=k) for l,s,e,k in rows])
args.output_prefix.with_name(args.output_prefix.name + '-summary.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary, indent=2))
