import type { RequestHandler } from "express";
import { verifyJwt } from "./local-auth.js";
import { consumeSseTicket } from "./sse-tickets.js";

/**
 * Express middleware that validates JWT from Authorization: Bearer <token> header.
 * Populates req.user with AuthUser.
 * Returns 401 if missing or invalid.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ")) {
		res.status(401).json({ success: false, error: "Missing authorization token" });
		return;
	}

	const token = header.slice(7);
	const payload = verifyJwt(token);
	if (!payload) {
		res.status(401).json({ success: false, error: "Invalid or expired token" });
		return;
	}

	req.user = {
		userId: payload.sub,
		teamId: payload.teamId,
		email: payload.email,
		role: payload.role,
	};

	next();
};

/**
 * Like requireAuth, but also accepts a single-use SSE ticket from ?ticket= query parameter.
 * Needed for SSE (EventSource can't set headers).
 *
 * Checks Authorization header first, then ?ticket= param via the short-lived ticket store.
 */
export const requireAuthOrToken: RequestHandler = (req, res, next) => {
	// Try Authorization header first
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ")) {
		const token = header.slice(7);
		const payload = verifyJwt(token);
		if (payload) {
			req.user = {
				userId: payload.sub,
				teamId: payload.teamId,
				email: payload.email,
				role: payload.role,
			};
			return next();
		}
	}

	// Try single-use SSE ticket
	const ticket = req.query.ticket as string | undefined;
	if (ticket) {
		const user = consumeSseTicket(ticket);
		if (user) {
			req.user = user as any;
			return next();
		}
	}

	res.status(401).json({ success: false, error: "Missing or invalid authorization" });
};
