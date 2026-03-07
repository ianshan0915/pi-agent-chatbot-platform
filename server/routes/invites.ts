/**
 * Invite token management routes.
 *
 * Admins can create, list, and revoke invite tokens for their team.
 * Public validate endpoint lets the frontend check if an invite is valid.
 */

import { Router } from "express";
import crypto from "node:crypto";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/permissions.js";
import { sendInviteEmail } from "../services/email.js";
import { asyncRoute } from "../utils/async-handler.js";

export function createInvitesRouter(): Router {
	const router = Router();

	// GET /api/invites/validate?token=... — public, check if token is valid
	router.get("/validate", asyncRoute(async (req, res) => {
		const token = req.query.token as string;
		if (!token) {
			res.status(400).json({ success: false, error: "Token required" });
			return;
		}

		const db = getDatabase();
		const { rows } = await db.query<{ team_name: string; email: string | null }>(
			`SELECT t.name as team_name, i.email
			 FROM invite_tokens i
			 JOIN teams t ON t.id = i.team_id
			 WHERE i.token = $1 AND i.revoked_at IS NULL AND i.expires_at > NOW()
			   AND i.use_count < i.max_uses`,
			[token],
		);

		if (rows.length === 0) {
			res.json({ success: true, data: { valid: false } });
			return;
		}

		res.json({
			success: true,
			data: {
				valid: true,
				teamName: rows[0].team_name,
				restrictedEmail: rows[0].email || null,
			},
		});
	}));

	// All remaining routes require admin auth
	router.use(requireAuth, requireRole("admin"));

	// GET /api/invites — list active invite tokens for admin's team
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { rows } = await db.query(
			`SELECT i.id, i.token, i.label, i.email, i.max_uses, i.use_count,
			        i.expires_at, i.created_at, u.email as created_by_email
			 FROM invite_tokens i
			 JOIN users u ON u.id = i.created_by
			 WHERE i.team_id = $1 AND i.revoked_at IS NULL
			 ORDER BY i.created_at DESC`,
			[req.user!.teamId],
		);

		res.json({ success: true, data: { invites: rows } });
	}));

	// POST /api/invites — create a new invite token
	router.post("/", asyncRoute(async (req, res) => {
		const { email, label, maxUses } = req.body;
		const db = getDatabase();

		const token = crypto.randomBytes(24).toString("hex");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

		const { rows } = await db.query(
			`INSERT INTO invite_tokens (team_id, created_by, token, label, email, max_uses, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING id, token, label, email, max_uses, use_count, expires_at, created_at`,
			[
				req.user!.teamId,
				req.user!.userId,
				token,
				label || null,
				email || null,
				maxUses || 1,
				expiresAt,
			],
		);

		const invite = rows[0];
		const appUrl = process.env.APP_URL || "http://localhost:3001";
		const inviteUrl = `${appUrl}/?invite=${token}`;

		// Send invite email if email was provided
		if (email) {
			try {
				const teamResult = await db.query<{ name: string }>(
					"SELECT name FROM teams WHERE id = $1",
					[req.user!.teamId],
				);
				const teamName = teamResult.rows[0]?.name || "the team";
				const inviterName = req.user!.displayName || req.user!.email;
				await sendInviteEmail(email, inviteUrl, teamName, inviterName);
			} catch (err) {
				console.error("[invites] Failed to send invite email:", err);
				// Don't fail the invite creation
			}
		}

		res.status(201).json({
			success: true,
			data: { invite: { ...invite, url: inviteUrl } },
		});
	}));

	// DELETE /api/invites/:id — revoke an invite
	router.delete("/:id", asyncRoute(async (req, res) => {
		const { id } = req.params;
		const db = getDatabase();

		const result = await db.query(
			"UPDATE invite_tokens SET revoked_at = NOW() WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL",
			[id, req.user!.teamId],
		);

		if (result.rowCount === 0) {
			res.status(404).json({ success: false, error: "Invite not found" });
			return;
		}

		res.json({ success: true });
	}));

	return router;
}
