/**
 * Short-lived, single-use ticket store for SSE authentication.
 *
 * EventSource cannot set Authorization headers, so clients obtain a short-lived
 * ticket via POST /api/auth/sse-ticket (with their JWT) and then pass it as
 * ?ticket= query param when opening the SSE connection.
 *
 * Tickets expire after 30 seconds and are single-use (consumed on first validation).
 */

import { randomBytes } from "node:crypto";

interface TicketEntry {
	user: {
		userId: string;
		teamId: string;
		email: string;
		role: string;
	};
	expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

const TICKET_TTL_MS = 30_000; // 30 seconds
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds

/** Periodic cleanup of expired tickets. */
const cleanupInterval = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of tickets) {
		if (entry.expiresAt <= now) {
			tickets.delete(key);
		}
	}
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref(); // Don't prevent process exit

/** Create a single-use SSE ticket for the given user. */
export function createSseTicket(user: TicketEntry["user"]): string {
	const ticket = randomBytes(32).toString("hex");
	tickets.set(ticket, {
		user,
		expiresAt: Date.now() + TICKET_TTL_MS,
	});
	return ticket;
}

/**
 * Consume (validate + delete) an SSE ticket.
 * Returns the user data if valid, null if expired or not found.
 */
export function consumeSseTicket(ticket: string): TicketEntry["user"] | null {
	const entry = tickets.get(ticket);
	if (!entry) return null;

	// Always delete (single-use)
	tickets.delete(ticket);

	if (entry.expiresAt <= Date.now()) return null;

	return entry.user;
}
