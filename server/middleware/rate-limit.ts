import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** 300 req/min per user for general API routes */
export const apiRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 300,
	keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req),
	standardHeaders: true,
	legacyHeaders: false,
	message: { success: false, error: "Too many requests, please try again later" },
});

/** 5 req/min per IP+email for auth endpoints (login/register) */
export const authRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 5,
	keyGenerator: (req) => {
		const ip = ipKeyGenerator(req);
		const email = req.body?.email || "unknown";
		return `${ip}:${email}`;
	},
	standardHeaders: true,
	legacyHeaders: false,
	message: { success: false, error: "Too many auth attempts, please try again later" },
});
