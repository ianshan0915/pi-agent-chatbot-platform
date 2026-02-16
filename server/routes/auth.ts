import { Router } from "express";
import type { LoginRequest, RegisterRequest } from "../auth/types.js";
import {
	registerUser,
	loginUser,
	ConflictError,
	AuthError,
} from "../auth/local-auth.js";
import { requireAuth } from "../auth/middleware.js";
import { getDatabase } from "../db/index.js";

const router = Router();

// POST /api/auth/register
router.post("/register", async (req, res) => {
	const { email, password, displayName, teamName } =
		req.body as RegisterRequest;

	if (!email || !password) {
		res.status(400).json({ success: false, error: "Email and password are required" });
		return;
	}

	try {
		const db = getDatabase();
		const data = await registerUser(db, email, password, displayName, teamName);
		res.status(201).json({ success: true, data });
	} catch (err) {
		if (err instanceof ConflictError) {
			res.status(409).json({ success: false, error: err.message });
			return;
		}
		throw err;
	}
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
	const { email, password } = req.body as LoginRequest;

	if (!email || !password) {
		res.status(400).json({ success: false, error: "Email and password are required" });
		return;
	}

	try {
		const db = getDatabase();
		const data = await loginUser(db, email, password);
		res.json({ success: true, data });
	} catch (err) {
		if (err instanceof AuthError) {
			res.status(401).json({ success: false, error: err.message });
			return;
		}
		throw err;
	}
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
	res.json({ success: true, data: { user: req.user } });
});

export default router;
