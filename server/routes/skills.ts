/**
 * Skills management routes.
 *
 * CRUD for skills (SKILL.md files) with scope-based authorization.
 * Skills are stored via StorageService and metadata in PostgreSQL.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { getDatabase } from "../db/index.js";
import type { SkillRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import type { StorageService } from "../services/storage.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }); // 1MB max

/** Validate SKILL.md frontmatter: extract name and description */
function parseSkillMd(content: string): { name: string; description: string } | { error: string } {
	// SKILL.md uses YAML frontmatter: ---\nname: ...\ndescription: ...\n---
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) {
		return { error: "SKILL.md must contain YAML frontmatter (--- delimited)" };
	}

	const frontmatter = match[1];
	const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
	const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

	if (!nameMatch) {
		return { error: "SKILL.md frontmatter must contain a 'name' field" };
	}
	if (!descMatch) {
		return { error: "SKILL.md frontmatter must contain a 'description' field" };
	}

	const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
	const description = descMatch[1].trim().replace(/^["']|["']$/g, "");

	if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
		return { error: "Skill name must be lowercase a-z, 0-9, hyphens only, max 64 chars" };
	}
	if (description.length === 0 || description.length > 1024) {
		return { error: "Skill description is required and must be max 1024 chars" };
	}

	return { name, description };
}

export function createSkillsRouter(storage: StorageService): Router {
	const router = Router();
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// GET / — List visible skills (platform + user's team + user's own)
	// -----------------------------------------------------------------------
	router.get("/", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT id, scope, owner_id, name, description, created_at, updated_at
				 FROM skills
				 WHERE (scope = 'platform')
				    OR (scope = 'team' AND owner_id = $1)
				    OR (scope = 'user' AND owner_id = $2)
				 ORDER BY scope, name`,
				[req.user!.teamId, req.user!.userId],
			);

			res.json({ success: true, data: { skills: result.rows } });
		} catch (err) {
			console.error("[skills] GET / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// POST / — Upload a new skill (multipart: file + scope field)
	// -----------------------------------------------------------------------
	router.post("/", upload.single("file"), async (req: Request, res: Response) => {
		try {
			const scope = req.body.scope as string;
			if (!scope || !["platform", "team", "user"].includes(scope)) {
				res.status(400).json({ success: false, error: "scope must be 'platform', 'team', or 'user'" });
				return;
			}

			// Authorization: platform/team scope requires admin
			if ((scope === "platform" || scope === "team") && req.user!.role !== "admin") {
				res.status(403).json({ success: false, error: "Only admins can create platform/team skills" });
				return;
			}

			if (!req.file) {
				res.status(400).json({ success: false, error: "file field (SKILL.md) is required" });
				return;
			}

			const content = req.file.buffer.toString("utf-8");
			const parsed = parseSkillMd(content);
			if ("error" in parsed) {
				res.status(400).json({ success: false, error: parsed.error });
				return;
			}

			// Determine owner_id based on scope
			const ownerId = scope === "team" ? req.user!.teamId : scope === "platform" ? req.user!.teamId : req.user!.userId;
			const storageKey = `skills/${ownerId}/${parsed.name}/SKILL.md`;

			const db = getDatabase();

			// Store the file
			await storage.upload(storageKey, req.file.buffer, "text/markdown");

			// Upsert metadata
			await db.query(
				`INSERT INTO skills (scope, owner_id, name, description, storage_key)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (scope, owner_id, name)
				 DO UPDATE SET description = $4, storage_key = $5, updated_at = now()`,
				[scope, ownerId, parsed.name, parsed.description, storageKey],
			);

			res.status(201).json({ success: true, data: { name: parsed.name, scope } });
		} catch (err) {
			console.error("[skills] POST / error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// GET /:id/download — Download skill content
	// -----------------------------------------------------------------------
	router.get("/:id/download", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT * FROM skills WHERE id = $1`,
				[req.params.id],
			);

			if (result.rows.length === 0) {
				res.status(404).json({ success: false, error: "Skill not found" });
				return;
			}

			const skill = result.rows[0];

			// Check visibility
			const canAccess =
				skill.scope === "platform" ||
				(skill.scope === "team" && skill.owner_id === req.user!.teamId) ||
				(skill.scope === "user" && skill.owner_id === req.user!.userId);

			if (!canAccess) {
				res.status(403).json({ success: false, error: "Access denied" });
				return;
			}

			const data = await storage.download(skill.storage_key);
			res.setHeader("Content-Type", "text/markdown");
			res.setHeader("Content-Disposition", `attachment; filename="SKILL.md"`);
			res.send(data);
		} catch (err) {
			console.error("[skills] GET /:id/download error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	// -----------------------------------------------------------------------
	// DELETE /:id — Delete a skill
	// -----------------------------------------------------------------------
	router.delete("/:id", async (req: Request, res: Response) => {
		try {
			const db = getDatabase();
			const result = await db.query<SkillRow>(
				`SELECT * FROM skills WHERE id = $1`,
				[req.params.id],
			);

			if (result.rows.length === 0) {
				res.status(404).json({ success: false, error: "Skill not found" });
				return;
			}

			const skill = result.rows[0];

			// Authorization
			const canDelete =
				((skill.scope === "platform" || skill.scope === "team") && req.user!.role === "admin") ||
				(skill.scope === "user" && skill.owner_id === req.user!.userId);

			if (!canDelete) {
				res.status(403).json({ success: false, error: "Insufficient permissions" });
				return;
			}

			// Delete from storage and DB
			await storage.delete(skill.storage_key);
			await db.query(`DELETE FROM skills WHERE id = $1`, [req.params.id]);

			res.json({ success: true });
		} catch (err) {
			console.error("[skills] DELETE /:id error:", err);
			res.status(500).json({ success: false, error: "Internal server error" });
		}
	});

	return router;
}
