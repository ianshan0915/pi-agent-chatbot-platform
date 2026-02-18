/**
 * Jobs API Routes: CRUD endpoints for scheduled jobs.
 *
 * Authorization:
 * - User-scoped jobs: User owns, full CRUD access
 * - Team-scoped jobs: Admin creates/updates/deletes, all members view
 *
 * Endpoints:
 * - GET /api/jobs - List jobs (user's own + team if member)
 * - POST /api/jobs - Create job
 * - GET /api/jobs/:id - Get job details
 * - PATCH /api/jobs/:id - Update job
 * - DELETE /api/jobs/:id - Delete job
 * - POST /api/jobs/:id/trigger - Manually trigger job now
 * - GET /api/jobs/:id/runs - Paginated job run history
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { Cron } from "croner";
import type { ScheduledJobRow, JobRunRow, SkillRow, UserFileRow } from "../db/types.js";
import { getDatabase } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";
import { isOwner } from "../auth/permissions.js";
import type { CryptoService } from "../services/crypto.js";
import type { StorageService } from "../services/storage.js";
import { executeJob } from "../scheduler/job-executor.js";
import { deliverResult } from "../scheduler/delivery.js";
import { asyncRoute } from "../utils/async-handler.js";

export function createJobsRouter(storage: StorageService, crypto: CryptoService): Router {
	const router = Router();

	// All routes require authentication
	router.use(requireAuth);

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/**
	 * Check if user can access a job (owner or team member).
	 */
	async function canAccessJob(req: Request, job: ScheduledJobRow): Promise<boolean> {
		if (job.owner_type === "user") {
			return isOwner(req, job.owner_id);
		} else if (job.owner_type === "team") {
			// Check if user is member of the team
			return req.user!.teamId === job.owner_id;
		}
		return false;
	}

	/**
	 * Check if user can modify a job (owner for user-scoped, admin for team-scoped).
	 */
	async function canModifyJob(req: Request, job: ScheduledJobRow): Promise<boolean> {
		if (job.owner_type === "user") {
			return isOwner(req, job.owner_id);
		} else if (job.owner_type === "team") {
			return req.user!.teamId === job.owner_id && req.user!.role === "admin";
		}
		return false;
	}

	/**
	 * Validate cron expression and return next run time.
	 */
	function validateCronExpression(cronExpr: string): Date | null {
		try {
			const cron = new Cron(cronExpr);
			const next = cron.nextRun();
			return next || null;
		} catch {
			return null;
		}
	}

	/**
	 * Validate email format.
	 */
	function isValidEmail(email: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
	}

	/**
	 * Validate HTTPS URL.
	 */
	function isValidHttpsUrl(url: string): boolean {
		try {
			const parsed = new URL(url);
			return parsed.protocol === "https:";
		} catch {
			return false;
		}
	}

	/**
	 * Validate delivery config. Returns error string or null if valid.
	 */
	function validateDelivery(delivery: any): string | null {
		if (delivery.type === "email") {
			if (!delivery.to || !isValidEmail(delivery.to)) return "Invalid email address";
		} else if (delivery.type === "teams") {
			if (!delivery.webhook || !isValidHttpsUrl(delivery.webhook)) return "Invalid Teams webhook URL (must be HTTPS)";
		} else {
			return "delivery.type must be 'email' or 'teams'";
		}
		return null;
	}

	/**
	 * Validate that all skill_ids are accessible to the user. Returns error string or null.
	 */
	async function validateSkillIds(db: ReturnType<typeof getDatabase>, skillIds: string[], req: Request): Promise<string | null> {
		if (!skillIds || skillIds.length === 0) return null;
		const result = await db.query<SkillRow>(
			`SELECT id FROM skills
			 WHERE id = ANY($1)
			   AND ((scope = 'platform')
			     OR (scope = 'team' AND owner_id = $2)
			     OR (scope = 'user' AND owner_id = $3))`,
			[skillIds, req.user!.teamId, req.user!.userId],
		);
		if (result.rows.length !== skillIds.length) {
			return "One or more skill_ids are invalid or inaccessible";
		}
		return null;
	}

	/**
	 * Validate that all file_ids belong to the user. Returns error string or null.
	 */
	async function validateFileIds(db: ReturnType<typeof getDatabase>, fileIds: string[], req: Request): Promise<string | null> {
		if (!fileIds || fileIds.length === 0) return null;
		const result = await db.query<UserFileRow>(
			`SELECT id FROM user_files WHERE id = ANY($1) AND user_id = $2`,
			[fileIds, req.user!.userId],
		);
		if (result.rows.length !== fileIds.length) {
			return "One or more file_ids are invalid or do not belong to you";
		}
		return null;
	}

	// ---------------------------------------------------------------------------
	// 1. GET / — List jobs (user's own + team if member)
	// ---------------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs
			 WHERE (owner_type = 'user' AND owner_id = $1)
			    OR (owner_type = 'team' AND owner_id = $2)
			 ORDER BY created_at DESC`,
			[req.user!.userId, req.user!.teamId],
		);

		res.json({ success: true, data: { jobs: result.rows } });
	}));

	// ---------------------------------------------------------------------------
	// 2. POST / — Create a new job
	// ---------------------------------------------------------------------------
	router.post("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const {
			owner_type,
			name,
			description,
			cron_expr,
			prompt,
			skill_ids,
			file_ids,
			model_id,
			provider,
			delivery,
		} = req.body;

		// Validate required fields
		if (!name || !cron_expr || !prompt || !delivery) {
			return res.status(400).json({
				success: false,
				error: "Missing required fields: name, cron_expr, prompt, delivery",
			});
		}

		// Validate owner_type
		const ownerType = owner_type || "user";
		if (ownerType !== "user" && ownerType !== "team") {
			return res.status(400).json({ success: false, error: "owner_type must be 'user' or 'team'" });
		}

		// Check permissions for team-scoped jobs
		if (ownerType === "team" && req.user!.role !== "admin") {
			return res.status(403).json({ success: false, error: "Only admins can create team-scoped jobs" });
		}

		const ownerId = ownerType === "user" ? req.user!.userId : req.user!.teamId;

		// Validate cron expression
		const nextRunAt = validateCronExpression(cron_expr);
		if (!nextRunAt) {
			return res.status(400).json({ success: false, error: "Invalid cron expression" });
		}

		// Validate delivery config
		const deliveryError = validateDelivery(delivery);
		if (deliveryError) return res.status(400).json({ success: false, error: deliveryError });

		// Validate skill_ids and file_ids (if provided)
		const skillError = await validateSkillIds(db, skill_ids, req);
		if (skillError) return res.status(400).json({ success: false, error: skillError });

		const fileError = await validateFileIds(db, file_ids, req);
		if (fileError) return res.status(400).json({ success: false, error: fileError });

		// Create the job
		const jobId = randomUUID();
		const result = await db.query<ScheduledJobRow>(
			`INSERT INTO scheduled_jobs (
				id, owner_type, owner_id, name, description, cron_expr, next_run_at,
				prompt, skill_ids, file_ids, model_id, provider, delivery, created_by
			 )
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			 RETURNING *`,
			[
				jobId,
				ownerType,
				ownerId,
				name,
				description || null,
				cron_expr,
				nextRunAt,
				prompt,
				skill_ids || null,
				file_ids || null,
				model_id || null,
				provider || null,
				JSON.stringify(delivery),
				req.user!.userId,
			],
		);

		res.status(201).json({ success: true, data: { job: result.rows[0] } });
	}));

	// ---------------------------------------------------------------------------
	// 3. GET /:id — Get job details
	// ---------------------------------------------------------------------------
	router.get("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		const result = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs WHERE id = $1`,
			[id],
		);

		if (result.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Job not found" });
		}

		const job = result.rows[0];

		if (!(await canAccessJob(req, job))) {
			return res.status(403).json({ success: false, error: "Forbidden" });
		}

		res.json({ success: true, data: { job } });
	}));

	// ---------------------------------------------------------------------------
	// 4. PATCH /:id — Update job
	// ---------------------------------------------------------------------------
	router.patch("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		// Fetch existing job
		const existing = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs WHERE id = $1`,
			[id],
		);

		if (existing.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Job not found" });
		}

		const job = existing.rows[0];

		if (!(await canModifyJob(req, job))) {
			return res.status(403).json({ success: false, error: "Forbidden" });
		}

		// Build update query dynamically
		const updates: string[] = [];
		const values: any[] = [];
		let paramIndex = 1;

		const addField = (column: string, value: any) => {
			updates.push(`${column} = $${paramIndex++}`);
			values.push(value);
		};

		const {
			name,
			description,
			cron_expr,
			prompt,
			skill_ids,
			file_ids,
			model_id,
			provider,
			delivery,
			enabled,
		} = req.body;

		if (name !== undefined) addField("name", name);
		if (description !== undefined) addField("description", description);
		if (prompt !== undefined) addField("prompt", prompt);
		if (model_id !== undefined) addField("model_id", model_id);
		if (provider !== undefined) addField("provider", provider);

		if (cron_expr !== undefined) {
			const nextRunAt = validateCronExpression(cron_expr);
			if (!nextRunAt) {
				return res.status(400).json({ success: false, error: "Invalid cron expression" });
			}
			addField("cron_expr", cron_expr);
			addField("next_run_at", nextRunAt);
		}

		if (skill_ids !== undefined) {
			const skillError = await validateSkillIds(db, skill_ids, req);
			if (skillError) return res.status(400).json({ success: false, error: skillError });
			addField("skill_ids", skill_ids);
		}

		if (file_ids !== undefined) {
			const fileError = await validateFileIds(db, file_ids, req);
			if (fileError) return res.status(400).json({ success: false, error: fileError });
			addField("file_ids", file_ids);
		}

		if (delivery !== undefined) {
			const deliveryErr = validateDelivery(delivery);
			if (deliveryErr) return res.status(400).json({ success: false, error: deliveryErr });
			addField("delivery", JSON.stringify(delivery));
		}

		if (enabled !== undefined) {
			addField("enabled", enabled);
			if (enabled) updates.push(`failure_count = 0`);
		}

		if (updates.length === 0) {
			return res.status(400).json({ success: false, error: "No fields to update" });
		}

		updates.push(`updated_at = now()`);
		values.push(id);

		const result = await db.query<ScheduledJobRow>(
			`UPDATE scheduled_jobs SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
			values,
		);

		res.json({ success: true, data: { job: result.rows[0] } });
	}));

	// ---------------------------------------------------------------------------
	// 5. DELETE /:id — Delete job
	// ---------------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		// Fetch existing job
		const existing = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs WHERE id = $1`,
			[id],
		);

		if (existing.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Job not found" });
		}

		const job = existing.rows[0];

		if (!(await canModifyJob(req, job))) {
			return res.status(403).json({ success: false, error: "Forbidden" });
		}

		await db.query(`DELETE FROM scheduled_jobs WHERE id = $1`, [id]);

		res.json({ success: true, data: { message: "Job deleted" } });
	}));

	// ---------------------------------------------------------------------------
	// 6. POST /:id/trigger — Manually trigger job now
	// ---------------------------------------------------------------------------
	router.post("/:id/trigger", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		// Fetch existing job
		const existing = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs WHERE id = $1`,
			[id],
		);

		if (existing.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Job not found" });
		}

		const job = existing.rows[0];

		if (!(await canAccessJob(req, job))) {
			return res.status(403).json({ success: false, error: "Forbidden" });
		}

		// Execute the job asynchronously (don't block the response)
		const runId = randomUUID();
		await db.query(
			`INSERT INTO job_runs (id, job_id, status) VALUES ($1, $2, 'running')`,
			[runId, job.id],
		);

		// Execute in background
		(async () => {
			try {
				const execResult = await executeJob(job, db, storage, crypto);
				const deliveryResult = await deliverResult(job.delivery, job.name, execResult);

				const finalStatus = deliveryResult.status === "failed" ? "failed" : execResult.status;
				const finalError = deliveryResult.status === "failed"
					? `Delivery failed: ${deliveryResult.error}`
					: execResult.error;

				let truncatedOutput = execResult.output;
				if (truncatedOutput && truncatedOutput.length > 50_000) {
					truncatedOutput = truncatedOutput.substring(0, 50_000) + "\n\n[Output truncated]";
				}

				await db.query(
					`UPDATE job_runs
					 SET finished_at = now(),
					     status = $1,
					     result = $2,
					     error = $3,
					     usage = $4,
					     delivery_status = $5,
					     delivery_error = $6
					 WHERE id = $7`,
					[
						finalStatus,
						JSON.stringify({ output: truncatedOutput }),
						finalError,
						JSON.stringify(execResult.usage),
						deliveryResult.status,
						deliveryResult.error,
						runId,
					],
				);
			} catch (err: any) {
				console.error(`[jobs] Manual trigger failed for job ${id}:`, err);
				await db.query(
					`UPDATE job_runs SET finished_at = now(), status = 'failed', error = $1 WHERE id = $2`,
					[err.message || String(err), runId],
				).catch(() => {});
			}
		})();

		res.json({ success: true, data: { message: "Job triggered", runId } });
	}));

	// ---------------------------------------------------------------------------
	// 7. GET /:id/runs — Paginated job run history
	// ---------------------------------------------------------------------------
	router.get("/:id/runs", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const { id } = req.params;

		// Fetch existing job
		const existing = await db.query<ScheduledJobRow>(
			`SELECT * FROM scheduled_jobs WHERE id = $1`,
			[id],
		);

		if (existing.rows.length === 0) {
			return res.status(404).json({ success: false, error: "Job not found" });
		}

		const job = existing.rows[0];

		if (!(await canAccessJob(req, job))) {
			return res.status(403).json({ success: false, error: "Forbidden" });
		}

		// Pagination
		const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
		const offset = parseInt(req.query.offset as string) || 0;

		const result = await db.query<JobRunRow>(
			`SELECT * FROM job_runs
			 WHERE job_id = $1
			 ORDER BY started_at DESC
			 LIMIT $2 OFFSET $3`,
			[id, limit, offset],
		);

		res.json({ success: true, data: { runs: result.rows, limit, offset } });
	}));

	return router;
}
