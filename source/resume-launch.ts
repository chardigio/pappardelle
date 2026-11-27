// Getting a resumable pane's launch ready: its token, and the record it
// restores. Nothing here is committed until the pane exists, so a launch
// that fails or loses a race leaves the records for the next one.

import {randomBytes} from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {createLogger} from './logger.ts';
import {
	chooseResumeRecord,
	resumePaneId,
	type ResumePane,
} from './program-resume.ts';
import {
	tokenHash,
	type ResumeRecordDao,
	type SplitArrangement,
} from './resume-records-sqlite.ts';
import {DEFAULT_STATE_DIR} from './state-db.ts';

const log = createLogger('resume-launch');

export type PaneLaunch = {
	pane: ResumePane;
	token: string;
	/** Read and deleted by the pane's first process. */
	tokenFile: string;
	/** Read and deleted by the pane's monitor. */
	monitorTokenFile: string;
	/** The record's directory and argv, read and deleted by the pane. */
	restoreFile?: string;
	restore?: {argv: string[]; cwd: string};
};

export type LaunchDeps = {
	dao: ResumeRecordDao;
	repo: string;
	stateDir?: string;
	uid?: number;
	exists?: (dir: string) => boolean;
};

export function resumeDir(stateDir: string, repo: string, key: string): string {
	return path.join(
		stateDir,
		'resume',
		encodeURIComponent(repo),
		encodeURIComponent(key),
	);
}

function privateDir(dir: string, stateDir: string): void {
	mkdirSync(dir, {recursive: true, mode: 0o700});
	for (
		let current = dir;
		current.startsWith(stateDir) && current !== stateDir;
		current = path.dirname(current)
	)
		chmodSync(current, 0o700);
}

function writePrivate(file: string, content: string): void {
	writeFileSync(file, content, {mode: 0o600, flag: 'wx'});
}

/** A one-shot file's contents, deleting it. */
export function readOneShot(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	} finally {
		rmSync(file, {force: true});
	}
}

/**
 * The launch of `pane`: a fresh token in two one-shot files, and the
 * record it restores, if any. Nothing when Pappardelle runs as root, which
 * neither records nor restores.
 */
export function preparePaneLaunch(
	deps: LaunchDeps,
	key: string,
	pane: ResumePane,
	startDir: string,
	options: {restore?: boolean} = {},
): PaneLaunch | undefined {
	const uid = deps.uid ?? process.getuid?.();
	if (uid === undefined || uid === 0) return undefined;
	const stateDir = deps.stateDir ?? DEFAULT_STATE_DIR;
	const exists = deps.exists ?? existsSync;
	const dir = resumeDir(stateDir, deps.repo, key);
	privateDir(dir, stateDir);
	const id = `${resumePaneId(pane).replace(':', '-')}.${randomBytes(6).toString('hex')}`;
	const token = randomBytes(32).toString('base64url');
	const launch: PaneLaunch = {
		pane,
		token,
		tokenFile: path.join(dir, `${id}.token`),
		monitorTokenFile: path.join(dir, `${id}.monitor-token`),
	};
	writePrivate(launch.tokenFile, token);
	writePrivate(launch.monitorTokenFile, token);

	if (options.restore === false) return launch;
	const record = chooseResumeRecord(deps.dao.read(key, pane).records, uid);
	if (!record) return launch;
	let cwd = startDir;
	if (record.cwd && exists(record.cwd)) cwd = record.cwd;
	else if (record.cwdSource === 'report') {
		log.info(
			`Not restoring ${key} ${resumePaneId(pane)}: its directory is gone`,
		);
		return launch;
	}
	launch.restore = {argv: record.argv, cwd};
	launch.restoreFile = path.join(dir, `${id}.restore`);
	writePrivate(
		launch.restoreFile,
		[cwd, ...record.argv].map(line => `${line}\n`).join(''),
	);
	log.info(
		`Restoring ${key} ${resumePaneId(pane)}: ${path.basename(record.argv[0]!)}`,
	);
	return launch;
}

/**
 * After the pane's `new-session` or `respawn-pane`: when it made the pane,
 * the records are used up and the launch's token is the current one. When
 * it didn't, the one-shot files go and the records stay.
 */
export async function finishPaneLaunch(
	deps: Pick<LaunchDeps, 'dao'>,
	key: string,
	launch: PaneLaunch | undefined,
	created: boolean,
	arrangement?: SplitArrangement,
): Promise<void> {
	if (!launch) return;
	if (created) {
		await deps.dao.commitLaunch(
			key,
			launch.pane,
			tokenHash(launch.token),
			arrangement,
		);
		return;
	}
	for (const file of [
		launch.tokenFile,
		launch.monitorTokenFile,
		launch.restoreFile,
	])
		if (file) rmSync(file, {force: true});
}

/** A closed space's leftover one-shot files. */
export function removeResumeFiles(
	stateDir: string,
	repo: string,
	key: string,
): void {
	rmSync(resumeDir(stateDir, repo, key), {recursive: true, force: true});
}
