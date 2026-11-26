// Which issues Pappardelle created itself, as opposed to opening an issue
// that already existed. idow records it when it creates one.

export type IssueMeta = {createdByPappardelle: boolean; createdAt: string};

export interface IssueMetaDao {
	/** Null when nothing is recorded for the issue. */
	read(key: string): IssueMeta | null;
	/** Record that Pappardelle created the issue, now. */
	markCreated(key: string): Promise<void>;
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
