import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import type { Database } from "../db/types.js";
import type { AuthResponse, JwtPayload, RegisterResponse } from "./types.js";
import { sendVerificationEmail } from "../services/email.js";

const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = "7d";

// Account lockout: 5 failed attempts → 15 minute lockout
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

export class LockoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LockoutError";
	}
}

function checkAndRecordFailure(email: string): void {
	const key = email.toLowerCase();
	const entry = failedAttempts.get(key) || { count: 0, lockedUntil: 0 };
	entry.count++;
	if (entry.count >= MAX_FAILED_ATTEMPTS) {
		entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
	}
	failedAttempts.set(key, entry);
}

function checkLockout(email: string): void {
	const key = email.toLowerCase();
	const entry = failedAttempts.get(key);
	if (!entry) return;
	if (entry.lockedUntil > Date.now()) {
		const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
		throw new LockoutError(`Account temporarily locked. Try again in ${minutesLeft} minute(s).`);
	}
	// Lockout expired — clear it
	if (entry.lockedUntil > 0 && entry.lockedUntil <= Date.now()) {
		failedAttempts.delete(key);
	}
}

function clearFailures(email: string): void {
	failedAttempts.delete(email.toLowerCase());
}

/** Custom error for 400 validation failures. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Validate password complexity: min 8 chars, 1 lowercase, 1 uppercase, 1 number. */
export function validatePassword(password: string): void {
	if (password.length < 8) {
		throw new ValidationError("Password must be at least 8 characters long");
	}
	if (!/[a-z]/.test(password)) {
		throw new ValidationError("Password must contain at least one lowercase letter");
	}
	if (!/[A-Z]/.test(password)) {
		throw new ValidationError("Password must contain at least one uppercase letter");
	}
	if (!/[0-9]/.test(password)) {
		throw new ValidationError("Password must contain at least one number");
	}
}

function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new Error("JWT_SECRET environment variable is not set");
	}
	return secret;
}

/** Sign a JWT token from user data. */
export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">): string {
	return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

/** Verify and decode a JWT token. Returns null if invalid/expired. */
export function verifyJwt(token: string): JwtPayload | null {
	try {
		return jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as JwtPayload;
	} catch {
		return null;
	}
}

/**
 * Register a new user.
 *
 * When REGISTRATION_MODE=invite, an invite token is required and the user
 * joins the invite's team. Otherwise a new team is created.
 *
 * No JWT is issued — the user must verify their email first.
 */
export async function registerUser(
	db: Database,
	email: string,
	password: string,
	displayName?: string,
	teamName?: string,
	inviteToken?: string,
): Promise<RegisterResponse> {
	// Validate password complexity
	validatePassword(password);

	// Check for existing user — return same response to prevent enumeration
	const { rows: existing } = await db.query(
		"SELECT id FROM users WHERE email = $1",
		[email],
	);
	if (existing.length > 0) {
		throw new ConflictError("A user with this email already exists");
	}

	// Validate invite token if provided (route handler enforces invite-only mode)
	let inviteTeamId: string | null = null;
	let inviteTokenId: string | null = null;
	if (inviteToken) {
		const invite = await validateInviteToken(db, inviteToken, email);
		inviteTeamId = invite.teamId;
		inviteTokenId = invite.id;
	}

	const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
	const client = await db.getClient();
	let verificationToken: string;

	try {
		await client.query("BEGIN");

		let teamId: string;
		if (inviteTeamId) {
			teamId = inviteTeamId;
		} else {
			const { rows: teamRows } = await client.query(
				"INSERT INTO teams (name) VALUES ($1) RETURNING id",
				[teamName || "Personal"],
			);
			teamId = teamRows[0].id;
		}

		const role = inviteTeamId ? "member" : "admin";

		const { rows: userRows } = await client.query(
			`INSERT INTO users (team_id, email, password_hash, display_name, role, email_verified)
			 VALUES ($1, $2, $3, $4, $5, FALSE)
			 RETURNING id, email`,
			[teamId, email, passwordHash, displayName || null, role],
		);
		const user = userRows[0];

		if (inviteTokenId) {
			await client.query(
				"UPDATE invite_tokens SET use_count = use_count + 1 WHERE id = $1",
				[inviteTokenId],
			);
		}

		verificationToken = crypto.randomBytes(32).toString("hex");
		await client.query(
			`INSERT INTO email_verification_tokens (user_id, token, expires_at)
			 VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
			[user.id, verificationToken],
		);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	// Send verification email after transaction — failure here is non-fatal
	// (user can use "resend verification" to retry)
	const appUrl = process.env.APP_URL || "http://localhost:3001";
	const verificationUrl = `${appUrl}/api/auth/verify?token=${verificationToken}`;
	try {
		await sendVerificationEmail(email, verificationUrl);
	} catch (err) {
		console.error("[auth] Failed to send verification email:", err);
	}

	return {
		message: "Account created. Please check your email to verify your address.",
		requiresVerification: true,
	};
}

/**
 * Validate an invite token. Returns the invite's team_id and id.
 */
async function validateInviteToken(
	db: Database,
	token: string,
	email: string,
): Promise<{ id: string; teamId: string }> {
	const { rows } = await db.query<{ id: string; team_id: string; email: string | null; max_uses: number; use_count: number }>(
		`SELECT id, team_id, email, max_uses, use_count FROM invite_tokens
		 WHERE token = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
		[token],
	);
	if (rows.length === 0) {
		throw new ValidationError("Invalid or expired invite token");
	}
	const invite = rows[0];
	if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
		throw new ValidationError("This invite is for a different email address");
	}
	if (invite.use_count >= invite.max_uses) {
		throw new ValidationError("This invite has been fully used");
	}
	return { id: invite.id, teamId: invite.team_id };
}

/**
 * Login an existing user with email/password.
 * Updates last_login timestamp. Requires email to be verified.
 */
export async function loginUser(
	db: Database,
	email: string,
	password: string,
): Promise<AuthResponse> {
	// Check lockout before doing any work
	checkLockout(email);

	const { rows } = await db.query(
		`SELECT u.id, u.email, u.password_hash, u.display_name, u.role, u.team_id, u.email_verified, t.name as team_name
		 FROM users u
		 JOIN teams t ON t.id = u.team_id
		 WHERE u.email = $1`,
		[email],
	);

	if (rows.length === 0) {
		checkAndRecordFailure(email);
		throw new AuthError("Invalid email or password");
	}

	const user = rows[0];

	if (!user.password_hash) {
		throw new AuthError("This account uses SSO login");
	}

	const valid = await bcrypt.compare(password, user.password_hash);
	if (!valid) {
		checkAndRecordFailure(email);
		throw new AuthError("Invalid email or password");
	}

	// Check email verification
	if (!user.email_verified) {
		throw new UnverifiedError("Please verify your email address before signing in.");
	}

	// Successful login — clear any failed attempts
	clearFailures(email);

	// Update last_login
	await db.query("UPDATE users SET last_login = now() WHERE id = $1", [
		user.id,
	]);

	const token = signJwt({
		sub: user.id,
		teamId: user.team_id,
		email: user.email,
		role: user.role,
	});

	return {
		token,
		user: {
			id: user.id,
			email: user.email,
			displayName: user.display_name,
			role: user.role,
			teamId: user.team_id,
			teamName: user.team_name,
		},
	};
}

/**
 * Verify an email address using a verification token.
 */
export async function verifyEmail(db: Database, token: string): Promise<void> {
	const { rows } = await db.query<{ id: string; user_id: string }>(
		`SELECT id, user_id FROM email_verification_tokens
		 WHERE token = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
		[token],
	);

	if (rows.length === 0) {
		throw new ValidationError("Invalid or expired verification link");
	}

	const { id, user_id } = rows[0];

	await db.query(
		"UPDATE email_verification_tokens SET consumed_at = NOW() WHERE id = $1",
		[id],
	);
	await db.query(
		"UPDATE users SET email_verified = TRUE WHERE id = $1",
		[user_id],
	);
}

/**
 * Resend verification email. Always returns success to prevent enumeration.
 */
export async function resendVerification(db: Database, email: string): Promise<void> {
	const { rows } = await db.query<{ id: string }>(
		"SELECT id FROM users WHERE email = $1 AND email_verified = FALSE",
		[email],
	);

	if (rows.length === 0) return; // User not found or already verified — silent success

	const userId = rows[0].id;

	// Delete old pending tokens
	await db.query(
		"DELETE FROM email_verification_tokens WHERE user_id = $1 AND consumed_at IS NULL",
		[userId],
	);

	// Create new token
	const verificationToken = crypto.randomBytes(32).toString("hex");
	await db.query(
		`INSERT INTO email_verification_tokens (user_id, token, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
		[userId, verificationToken],
	);

	const appUrl = process.env.APP_URL || "http://localhost:3001";
	const verificationUrl = `${appUrl}/api/auth/verify?token=${verificationToken}`;
	await sendVerificationEmail(email, verificationUrl);
}

/** Custom error for 409 Conflict (duplicate registration). */
export class ConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}

/** Custom error for 401 Unauthorized (bad credentials). */
export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

/** Custom error for 403 Forbidden (email not verified). */
export class UnverifiedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnverifiedError";
	}
}
