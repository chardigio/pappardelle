// Which issues Pappardelle created itself, as opposed to opening an issue
// that already existed. idow records it when it creates one.
//
// Layout: ~/.pappardelle/repos/{repoName}/issue-meta/{ISSUE-KEY}.json

import fs from 'node:fs';
import path from 'node:path';

export type IssueMeta = {createdByPappardelle: boolean; createdAt: string};

export interface IssueMetaDao {
	/** Null when nothing is recorded for the issue. */
	read(key: string): IssueMeta | null;
	/** Record that Pappardelle created the issue, now. */
	markCreated(key: string): Promise<void>;
}

/** A record as it is kept in its file. Throws when `content` is anything else. */
export function parseIssueMeta(content: string): IssueMeta {
	const record = JSON.parse(content) as Record<string, unknown> | null;
	const createdByPappardelle = record?.['created_by_pappardelle'];
	const createdAt = record?.['created_at'];
	if (
		typeof createdByPappardelle !== 'boolean' ||
		typeof createdAt !== 'string'
	)
		throw new Error('Not an issue-meta record');
	return {createdByPappardelle, createdAt};
}

export function renderIssueMeta(meta: IssueMeta): string {
	return (
		JSON.stringify({
			created_by_pappardelle: meta.createdByPappardelle,
			created_at: meta.createdAt,
		}) + '\n'
	);
}

/** The time as idow has always written it: UTC, to the second. */
export function createdNow(clock: () => Date): IssueMeta {
	return {
		createdByPappardelle: true,
		createdAt: clock()
			.toISOString()
			.replace(/\.\d{3}Z$/, 'Z'),
	};
}

export class JsonIssueMetaDao implements IssueMetaDao {
	constructor(
		private readonly dir: string,
		private readonly clock: () => Date,
	) {}

	file(key: string): string {
		return path.join(this.dir, `${key}.json`);
	}

	read(key: string): IssueMeta | null {
		try {
			return parseIssueMeta(fs.readFileSync(this.file(key), 'utf8'));
		} catch {
			return null;
		}
	}

	async markCreated(key: string): Promise<void> {
		fs.mkdirSync(this.dir, {recursive: true});
		fs.writeFileSync(this.file(key), renderIssueMeta(createdNow(this.clock)));
	}
}
