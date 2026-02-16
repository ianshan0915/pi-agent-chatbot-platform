import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/permissions.js";
import { getDatabase } from "../db/index.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------- helpers ----------

interface SettingsRow {
	user_settings: Record<string, unknown>;
	team_settings: Record<string, unknown>;
	team_name: string;
	role: string;
}

async function fetchSettings(userId: string, teamId: string): Promise<SettingsRow> {
	const db = getDatabase();
	const { rows } = await db.query(
		`SELECT u.settings AS user_settings,
		        t.settings AS team_settings,
		        t.name     AS team_name,
		        u.role
		   FROM users u
		   JOIN teams t ON u.team_id = t.id
		  WHERE u.id = $1 AND u.team_id = $2`,
		[userId, teamId],
	);
	return rows[0] as SettingsRow;
}

function settingsPayload(row: SettingsRow) {
	return {
		userSettings: row.user_settings ?? {},
		teamSettings: row.team_settings ?? {},
		teamName: row.team_name,
		role: row.role,
	};
}

// ---------- GET / ----------

router.get("/", async (req: Request, res: Response) => {
	try {
		const { userId, teamId } = req.user!;
		const row = await fetchSettings(userId, teamId);
		if (!row) {
			res.status(404).json({ success: false, error: "User not found" });
			return;
		}
		res.json({ success: true, data: settingsPayload(row) });
	} catch (err) {
		console.error("[settings] GET / error:", err);
		res.status(500).json({ success: false, error: "Failed to fetch settings" });
	}
});

// ---------- PATCH / ----------

router.patch("/", async (req: Request, res: Response) => {
	try {
		const { userId, teamId } = req.user!;
		const { settings } = req.body as { settings?: Record<string, unknown> };

		if (!settings || typeof settings !== "object") {
			res.status(400).json({ success: false, error: "Invalid settings payload" });
			return;
		}

		const db = getDatabase();
		await db.query(
			`UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
			[JSON.stringify(settings), userId],
		);

		const row = await fetchSettings(userId, teamId);
		res.json({ success: true, data: settingsPayload(row) });
	} catch (err) {
		console.error("[settings] PATCH / error:", err);
		res.status(500).json({ success: false, error: "Failed to update user settings" });
	}
});

// ---------- PATCH /team ----------

router.patch("/team", requireRole("admin"), async (req: Request, res: Response) => {
	try {
		const { userId, teamId } = req.user!;
		const { settings, name } = req.body as {
			settings?: Record<string, unknown>;
			name?: string;
		};

		if (!settings && !name) {
			res.status(400).json({ success: false, error: "Nothing to update" });
			return;
		}

		const db = getDatabase();

		if (settings && typeof settings === "object") {
			await db.query(
				`UPDATE teams SET settings = settings || $1::jsonb WHERE id = $2`,
				[JSON.stringify(settings), teamId],
			);
		}

		if (name && typeof name === "string") {
			await db.query(
				`UPDATE teams SET name = $1 WHERE id = $2`,
				[name, teamId],
			);
		}

		const row = await fetchSettings(userId, teamId);
		res.json({ success: true, data: settingsPayload(row) });
	} catch (err) {
		console.error("[settings] PATCH /team error:", err);
		res.status(500).json({ success: false, error: "Failed to update team settings" });
	}
});

export default router;
