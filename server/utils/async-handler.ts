/**
 * Async route handler wrapper that catches errors and returns a 500 response.
 *
 * Eliminates the need for try/catch in every route handler.
 * Usage: router.get("/", asyncRoute(async (req, res) => { ... }));
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

export function asyncRoute(
	fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
): RequestHandler {
	return (req, res, next) => {
		Promise.resolve(fn(req, res, next)).catch((err) => {
			console.error(`[${req.method} ${req.baseUrl}${req.path}] Error:`, err);
			if (!res.headersSent) {
				res.status(500).json({ success: false, error: "Internal server error" });
			}
		});
	};
}
