/**
 * Seed platform-scope skills on server startup.
 *
 * Unlike seed profiles (SQL-only), skills need both a DB row and a file
 * in storage. This function is idempotent — it skips skills that already exist.
 *
 * Bundle skills (format: "zip") are read from server/seed-data/.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./types.js";
import type { StorageService } from "../services/storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DATA_DIR = path.resolve(__dirname, "../seed-data");
const PLATFORM_OWNER_ID = "00000000-0000-0000-0000-000000000000";

interface BundleSeedSkill {
	name: string;
	description: string;
	/** Directory name under server/seed-data/ */
	dirName: string;
}

const SEED_SKILLS: BundleSeedSkill[] = [
	{
		name: "skill-creator",
		description:
			"Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.",
		dirName: "skill-creator",
	},
];

/** Recursively walk a directory and return relative paths + file buffers */
async function walkDir(dir: string, base?: string): Promise<Array<{ relativePath: string; data: Buffer }>> {
	const results: Array<{ relativePath: string; data: Buffer }> = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relPath = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			const sub = await walkDir(fullPath, relPath);
			results.push(...sub);
		} else if (entry.isFile()) {
			results.push({ relativePath: relPath, data: await fs.readFile(fullPath) });
		}
	}
	return results;
}

/**
 * Seed platform-scope skills if they don't already exist.
 * Writes skill content to storage and upserts DB rows.
 */
export async function seedSkills(db: Database, storage: StorageService): Promise<void> {
	for (const skill of SEED_SKILLS) {
		try {
			// Check if this seed skill already exists
			const existing = await db.query(
				`SELECT id FROM skills WHERE scope = 'platform' AND owner_id = $1 AND name = $2`,
				[PLATFORM_OWNER_ID, skill.name],
			);
			if (existing.rows.length > 0) continue;

			const storagePrefix = `skills/${PLATFORM_OWNER_ID}/${skill.name}/`;

			// Bundle skill: read all files from seed-data directory
			const seedDir = path.join(SEED_DATA_DIR, skill.dirName);
			const files = await walkDir(seedDir);

			for (const file of files) {
				await storage.upload(storagePrefix + file.relativePath, file.data);
			}

			await db.query(
				`INSERT INTO skills (scope, owner_id, name, description, format, storage_key)
				 VALUES ('platform', $1, $2, $3, 'zip', $4)
				 ON CONFLICT (scope, owner_id, name) DO NOTHING`,
				[PLATFORM_OWNER_ID, skill.name, skill.description, storagePrefix],
			);

			console.log(`[seed-skills] Created platform skill: ${skill.name}`);
		} catch (err) {
			console.error(`[seed-skills] Failed to seed skill "${skill.name}":`, err);
		}
	}
}
