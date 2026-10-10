import {useEffect, useState} from 'react';
import {
	skillRoots,
	skillSnapshot,
	type SkillEntry,
	type SkillRoots,
	type SkillSnapshot,
} from './skill-completion.ts';

/**
 * The skills the new-session prompt completes against. The first frame gets
 * whatever the last scan found, so typing never waits on the disk, and the
 * rescan started here replaces it when it lands.
 */
export function useSkillSnapshot(
	store: SkillSnapshot = skillSnapshot,
	roots: SkillRoots | null = skillRoots(),
): SkillEntry[] {
	const [skills, setSkills] = useState<SkillEntry[]>(() =>
		roots ? (store.current(roots) ?? []) : [],
	);

	const repoRoot = roots?.repoRoot;
	const homeDir = roots?.homeDir;
	useEffect(() => {
		if (repoRoot === undefined || homeDir === undefined) return;
		let cancelled = false;
		void store.refresh({repoRoot, homeDir}).then(entries => {
			if (!cancelled) setSkills(entries);
		});
		return () => {
			cancelled = true;
		};
	}, [store, repoRoot, homeDir]);

	return skills;
}
