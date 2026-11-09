// OS user timers that run `pappardelle schedule fire ID`: systemd on Linux and
// launchd on macOS. Both survive the TUI restarting, which is the point: a
// usage limit can be days away.

import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Job, TimerWhen} from './schedule.ts';

export type RunCommand = (
	command: string,
	args: string[],
) => {status: number | null; stderr: string};

export type TimerContext = {
	repo: string;
	/** The main checkout, where `pappardelle` finds the repo's config. */
	cwd: string;
	/** The executable and arguments that run this build's CLI. */
	launch: string[];
	/** Passed through, since timer services don't start with the shell's. */
	env: Record<string, string>;
	run: RunCommand;
};

export interface TimerBackend {
	create(job: Job, when: TimerWhen): void;
	remove(job: Job): void;
}

export class TimerError extends Error {}

function fireArgs(context: TimerContext, job: Job): string[] {
	return [...context.launch, 'schedule', 'fire', job.id];
}

function check(result: ReturnType<RunCommand>, what: string): void {
	if (result.status !== 0) {
		throw new TimerError(`${what} failed: ${result.stderr.trim()}`);
	}
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** Local time in the form systemd's OnCalendar takes. */
export function onCalendar(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export function systemdUnitName(repo: string, job: Job): string {
	return `pappardelle-${repo.replaceAll(/[^\w:.-]/g, '_')}-${job.id}`;
}

export function systemdBackend(context: TimerContext): TimerBackend {
	return {
		create(job, when) {
			const unit = systemdUnitName(context.repo, job);
			const schedule =
				'at' in when
					? [`--on-calendar=${onCalendar(when.at)}`]
					: [
							`--on-active=${when.everySeconds}s`,
							`--on-unit-active=${when.everySeconds}s`,
						];
			check(
				context.run('systemd-run', [
					'--user',
					`--unit=${unit}`,
					`--description=Pappardelle wake-up for ${job.key}`,
					// An elapsed one-shot timer otherwise stays loaded and holds its name.
					'--timer-property=RemainAfterElapse=no',
					// systemd otherwise batches timers to the minute.
					'--timer-property=AccuracySec=1s',
					`--working-directory=${context.cwd}`,
					...Object.entries(context.env).map(
						([name, value]) => `--setenv=${name}=${value}`,
					),
					...schedule,
					'--',
					...fireArgs(context, job),
				]),
				'systemd-run',
			);
		},
		remove(job) {
			const unit = systemdUnitName(context.repo, job);
			// Stopping only the timer: a fired job removes itself from inside the
			// service, which stopping would kill mid-run.
			context.run('systemctl', ['--user', 'stop', `${unit}.timer`]);
		},
	};
}

export function launchdLabel(repo: string, job: Job): string {
	return `dev.pappardelle.${repo.replaceAll(/[^\w.-]/g, '_')}.${job.id}`;
}

function plistValue(value: unknown, indent: string): string {
	if (typeof value === 'number') return `${indent}<integer>${value}</integer>`;
	if (typeof value === 'string') {
		const escaped = value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;');
		return `${indent}<string>${escaped}</string>`;
	}

	if (Array.isArray(value)) {
		return [
			`${indent}<array>`,
			...value.map(item => plistValue(item, `${indent}\t`)),
			`${indent}</array>`,
		].join('\n');
	}

	const entries = Object.entries(value as Record<string, unknown>);
	return [
		`${indent}<dict>`,
		...entries.flatMap(([name, item]) => [
			`${indent}\t<key>${name}</key>`,
			plistValue(item, `${indent}\t`),
		]),
		`${indent}</dict>`,
	].join('\n');
}

export function launchdPlist(
	context: TimerContext,
	job: Job,
	when: TimerWhen,
): string {
	const schedule =
		'at' in when
			? {
					StartCalendarInterval: {
						Month: when.at.getMonth() + 1,
						Day: when.at.getDate(),
						Hour: when.at.getHours(),
						Minute: when.at.getMinutes(),
					},
				}
			: {StartInterval: when.everySeconds};
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		plistValue(
			{
				Label: launchdLabel(context.repo, job),
				ProgramArguments: fireArgs(context, job),
				WorkingDirectory: context.cwd,
				EnvironmentVariables: context.env,
				...schedule,
			},
			'',
		),
		'</plist>',
		'',
	].join('\n');
}

export function launchdBackend(
	context: TimerContext & {home: string; uid: number},
): TimerBackend {
	const plistPath = (job: Job) =>
		path.join(
			context.home,
			'Library',
			'LaunchAgents',
			`${launchdLabel(context.repo, job)}.plist`,
		);
	return {
		create(job, when) {
			const file = plistPath(job);
			mkdirSync(path.dirname(file), {recursive: true});
			writeFileSync(file, launchdPlist(context, job, when));
			check(
				context.run('launchctl', ['bootstrap', `gui/${context.uid}`, file]),
				'launchctl bootstrap',
			);
		},
		remove(job) {
			rmSync(plistPath(job), {force: true});
			// Last, since booting out a job that is running ends its process.
			context.run('launchctl', [
				'bootout',
				`gui/${context.uid}/${launchdLabel(context.repo, job)}`,
			]);
		},
	};
}
