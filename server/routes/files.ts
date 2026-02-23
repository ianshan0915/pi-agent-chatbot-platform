/**
 * User file upload/download routes.
 *
 * Files are stored via StorageService, metadata in PostgreSQL.
 * Each user can only access their own files.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { getDatabase } from "../db/index.js";
import type { UserFileRow } from "../db/types.js";
import { requireAuth } from "../auth/middleware.js";
import type { StorageService } from "../services/storage.js";
import { asyncRoute } from "../utils/async-handler.js";
import { contentDisposition } from "../utils/sanitize-filename.js";

/** Allowed MIME types for file uploads */
const ALLOWED_MIME_TYPES = new Set([
	// Text
	"text/plain", "text/csv", "text/html", "text/css", "text/javascript", "text/markdown",
	"text/xml", "text/yaml",
	// Documents
	"application/pdf",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	// Data
	"application/json", "application/xml",
	// Images
	"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
	// Archives
	"application/zip", "application/gzip",
	// Fallback for unknown types (Content-Disposition: attachment prevents execution)
	"application/octet-stream",
]);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

export function createFilesRouter(storage: StorageService): Router {
	const router = Router();
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// GET / — List user's files
	// -----------------------------------------------------------------------
	router.get("/", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<UserFileRow>(
			`SELECT id, filename, content_type, size_bytes, created_at
			 FROM user_files
			 WHERE user_id = $1
			 ORDER BY created_at DESC`,
			[req.user!.userId],
		);

		res.json({ success: true, data: { files: result.rows } });
	}));

	// -----------------------------------------------------------------------
	// POST / — Upload a file (multipart)
	// -----------------------------------------------------------------------
	router.post("/", upload.single("file"), asyncRoute(async (req, res) => {
		if (!req.file) {
			res.status(400).json({ success: false, error: "file field is required" });
			return;
		}

		// 1.13 MIME type allowlist
		const mimeType = req.file.mimetype || "application/octet-stream";
		const isTextWildcard = mimeType.startsWith("text/");
		if (!isTextWildcard && !ALLOWED_MIME_TYPES.has(mimeType)) {
			res.status(400).json({ success: false, error: `File type "${mimeType}" is not allowed` });
			return;
		}

		const db = getDatabase();
		const fileId = crypto.randomUUID();
		const storageKey = `files/${req.user!.userId}/${fileId}/${req.file.originalname}`;

		await storage.upload(storageKey, req.file.buffer, req.file.mimetype);

		await db.query(
			`INSERT INTO user_files (id, user_id, filename, content_type, size_bytes, storage_key)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[fileId, req.user!.userId, req.file.originalname, req.file.mimetype, req.file.size, storageKey],
		);

		res.status(201).json({
			success: true,
			data: {
				id: fileId,
				filename: req.file.originalname,
				content_type: req.file.mimetype,
				size_bytes: req.file.size,
			},
		});
	}));

	// -----------------------------------------------------------------------
	// GET /:id — Download a file
	// -----------------------------------------------------------------------
	router.get("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<UserFileRow>(
			`SELECT * FROM user_files WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);

		if (result.rows.length === 0) {
			res.status(404).json({ success: false, error: "File not found" });
			return;
		}

		const file = result.rows[0];
		const data = await storage.download(file.storage_key);

		res.setHeader("Content-Type", file.content_type || "application/octet-stream");
		res.setHeader("Content-Disposition", contentDisposition(file.filename));
		res.send(data);
	}));

	// -----------------------------------------------------------------------
	// DELETE /:id — Delete a file (owner only)
	// -----------------------------------------------------------------------
	router.delete("/:id", asyncRoute(async (req, res) => {
		const db = getDatabase();
		const result = await db.query<UserFileRow>(
			`SELECT * FROM user_files WHERE id = $1 AND user_id = $2`,
			[req.params.id, req.user!.userId],
		);

		if (result.rows.length === 0) {
			res.status(404).json({ success: false, error: "File not found" });
			return;
		}

		const file = result.rows[0];
		await storage.delete(file.storage_key);
		await db.query(`DELETE FROM user_files WHERE id = $1`, [req.params.id]);

		res.json({ success: true });
	}));

	return router;
}
