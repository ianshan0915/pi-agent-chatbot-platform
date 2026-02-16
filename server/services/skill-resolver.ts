/**
 * Skill Resolver: downloads skill files to temp dirs for CLI injection.
 *
 * Resolves all skills visible to a user (platform + team + user scope),
 * downloads SKILL.md from StorageService to temp directories, and returns
 * paths suitable for `--skill <path>` CLI args.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Database, SkillRow } from "../db/types.js";
import type { StorageService } from "./storage.js";

export interface ResolvedSkills {
	/** Absolute paths to skill directories (each contains a SKILL.md) */
	skillPaths: string[];
	/** Call to remove temp directories when session ends */
	cleanup: () => void;
}

export async function resolveSkillsForUser(
	db: Database,
	storage: StorageService,
	userId: string,
	teamId: string,
): Promise<ResolvedSkills> {
	const result = await db.query<SkillRow>(
		`SELECT name, storage_key FROM skills
		 WHERE (scope = 'platform')
		    OR (scope = 'team' AND owner_id = $1)
		    OR (scope = 'user' AND owner_id = $2)
		 ORDER BY scope, name`,
		[teamId, userId],
	);

	if (result.rows.length === 0) {
		return { skillPaths: [], cleanup: () => {} };
	}

	const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-"));
	const skillPaths: string[] = [];

	for (const skill of result.rows) {
		try {
			const skillDir = path.join(tmpBase, skill.name);
			await fs.mkdir(skillDir, { recursive: true });

			const data = await storage.download(skill.storage_key);
			await fs.writeFile(path.join(skillDir, "SKILL.md"), data);

			skillPaths.push(skillDir);
		} catch (err) {
			console.error(`[skill-resolver] Failed to resolve skill "${skill.name}":`, err);
		}
	}

	const cleanup = () => {
		fs.rm(tmpBase, { recursive: true, force: true }).catch((err) => {
			console.error("[skill-resolver] Failed to clean up temp dir:", err);
		});
	};

	return { skillPaths, cleanup };
}
