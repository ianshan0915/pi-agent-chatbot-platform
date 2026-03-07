import { Router } from "express";
import type { LoginRequest, RegisterRequest } from "../auth/types.js";
import {
	registerUser,
	loginUser,
	verifyEmail,
	resendVerification,
	ConflictError,
	AuthError,
	ValidationError,
	LockoutError,
	UnverifiedError,
} from "../auth/local-auth.js";
import { requireAuth } from "../auth/middleware.js";
import { createSseTicket } from "../auth/sse-tickets.js";
import { signupRateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../services/turnstile.js";
import { getDatabase } from "../db/index.js";

const router = Router();

// POST /api/auth/register
router.post("/register", signupRateLimit, async (req, res) => {
	const { email, password, displayName, teamName, inviteToken, turnstileToken } =
		req.body as RegisterRequest;

	if (!email || !password) {
		res.status(400).json({ success: false, error: "Email and password are required" });
		return;
	}

	try {
		// Verify Turnstile token first (fail fast)
		const turnstileValid = await verifyTurnstileToken(turnstileToken || "", req.ip);
		if (!turnstileValid) {
			res.status(400).json({ success: false, error: "CAPTCHA verification failed. Please try again." });
			return;
		}

		// Check invite-only mode
		const registrationMode = process.env.REGISTRATION_MODE || "open";
		if (registrationMode === "invite" && !inviteToken) {
			res.status(403).json({ success: false, error: "Registration is by invitation only" });
			return;
		}

		const db = getDatabase();
		const data = await registerUser(db, email, password, displayName, teamName, inviteToken);
		res.status(201).json({ success: true, data });
	} catch (err) {
		if (err instanceof ValidationError) {
			res.status(400).json({ success: false, error: err.message });
			return;
		}
		if (err instanceof ConflictError) {
			// Return same 201 response to prevent email enumeration
			res.status(201).json({
				success: true,
				data: {
					message: "Account created. Please check your email to verify your address.",
					requiresVerification: true,
				},
			});
			console.warn(`[auth] Registration attempt with existing email: ${email}`);
			return;
		}
		throw err;
	}
});

// GET /api/auth/verify?token=...
router.get("/verify", async (req, res) => {
	const token = req.query.token as string;
	if (!token) {
		res.status(400).json({ success: false, error: "Verification token required" });
		return;
	}

	try {
		const db = getDatabase();
		await verifyEmail(db, token);
		const appUrl = process.env.APP_URL || "http://localhost:3001";
		res.redirect(`${appUrl}/?verified=true`);
	} catch (err) {
		if (err instanceof ValidationError) {
			res.status(400).json({ success: false, error: err.message });
			return;
		}
		throw err;
	}
});

// POST /api/auth/resend-verification
router.post("/resend-verification", signupRateLimit, async (req, res) => {
	const { email } = req.body;
	if (!email) {
		res.status(400).json({ success: false, error: "Email is required" });
		return;
	}

	try {
		const db = getDatabase();
		await resendVerification(db, email);
	} catch {
		// Swallow errors to prevent enumeration
	}

	// Always return success
	res.json({ success: true, message: "If an account exists with that email, a verification link has been sent." });
});

// GET /api/auth/registration-config — public endpoint for frontend to know what to render
router.get("/registration-config", (_req, res) => {
	res.json({
		mode: process.env.REGISTRATION_MODE || "open",
		turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
	});
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
		if (err instanceof LockoutError) {
			res.status(429).json({ success: false, error: err.message });
			return;
		}
		if (err instanceof UnverifiedError) {
			res.status(403).json({ success: false, error: err.message, code: "EMAIL_NOT_VERIFIED" });
			return;
		}
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

// POST /api/auth/sse-ticket — Issue a short-lived, single-use ticket for SSE auth
router.post("/sse-ticket", requireAuth, (req, res) => {
	const ticket = createSseTicket(req.user!);
	res.json({ success: true, data: { ticket } });
});

export default router;
