/**
 * Cloudflare Turnstile verification.
 *
 * Returns true if TURNSTILE_SECRET_KEY is not set (graceful skip for dev).
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
	const secret = process.env.TURNSTILE_SECRET_KEY;
	if (!secret) return true; // Dev mode: skip verification

	if (!token) return false;

	const body: Record<string, string> = { secret, response: token };
	if (remoteIp) body.remoteip = remoteIp;

	const res = await fetch(VERIFY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const data = await res.json() as { success: boolean };
	return data.success === true;
}
