/**
 * Session pool manager for AgentSession instances.
 *
 * Tracks AgentSession objects from @mariozechner/pi-coding-agent.
 *
 * Manages lifecycle with:
 * - Idle timeout and reaping
 * - Capacity limits (aggressive timeout when near capacity)
 * - Generating-state protection (never reap active sessions)
 * - Graceful shutdown
 */

import { EventEmitter } from "node:events";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";

export interface SessionInfo {
	session: AgentSession;
	resourceLoader: ResourceLoader;
	authStorage: AuthStorage;
	userId: string;
	teamId: string;
	lastActivity: number;
	/** Unsubscribe from session events. */
	unsubscribe?: () => void;
	/** Cleanup callback set by a detaching bridge so a reattaching bridge can close the old listener. */
	detachCleanup?: () => void;
}

export type SessionStopReason = "idle" | "error" | "shutdown";

export interface SessionPoolEvents {
	"session-stopped": (sessionId: string, reason: SessionStopReason) => void;
}

export interface SessionPoolOptions {
	maxSessions?: number;
	idleTimeoutMs?: number;
	sweepIntervalMs?: number;
}

export class SessionPool extends EventEmitter {
	private sessions = new Map<string, SessionInfo>();
	private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private generatingSessions = new Set<string>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private readonly maxSessions: number;
	private readonly idleTimeoutMs: number;
	private readonly aggressiveIdleTimeoutMs: number;

	constructor(options: SessionPoolOptions = {}) {
		super();
		this.maxSessions = options.maxSessions ?? parseInt(process.env.MAX_SDK_SESSIONS || "100", 10);
		this.idleTimeoutMs = options.idleTimeoutMs ?? parseInt(process.env.SDK_SESSION_IDLE_TIMEOUT_MS || "1800000", 10); // 30 min
		this.aggressiveIdleTimeoutMs = 5 * 60 * 1000; // 5 min when near capacity

		const sweepInterval = options.sweepIntervalMs ?? 30_000;
		this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
		// Don't keep the process alive just for the sweep timer
		this.sweepTimer.unref();
	}

	/**
	 * Store an already-created AgentSession in the pool.
	 * Starts the idle timer. Throws if pool is at capacity.
	 */
	acquire(opts: {
		sessionId: string;
		userId: string;
		teamId: string;
		session: AgentSession;
		resourceLoader: ResourceLoader;
		authStorage: AuthStorage;
	}): SessionInfo {
		// Check for existing session
		const existing = this.sessions.get(opts.sessionId);
		if (existing) {
			this.touch(opts.sessionId);
			return existing;
		}

		// Check capacity
		if (!this.hasCapacity()) {
			throw new SessionPoolCapacityError(
				`Session pool at capacity (${this.maxSessions}). Try again later.`,
			);
		}

		const info: SessionInfo = {
			session: opts.session,
			resourceLoader: opts.resourceLoader,
			authStorage: opts.authStorage,
			userId: opts.userId,
			teamId: opts.teamId,
			lastActivity: Date.now(),
		};

		this.sessions.set(opts.sessionId, info);
		this.startIdleTimer(opts.sessionId);

		return info;
	}

	/** Get a session by session ID. */
	get(sessionId: string): SessionInfo | undefined {
		return this.sessions.get(sessionId);
	}

	/** Reset the idle timer for a session (activity detected). */
	touch(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;

		info.lastActivity = Date.now();
		// If generating, just update timestamp — don't restart idle timer
		if (!this.generatingSessions.has(sessionId)) {
			this.clearIdleTimer(sessionId);
			this.startIdleTimer(sessionId);
		}
	}

	/**
	 * Release a session back to the pool. Starts the idle timer but does NOT
	 * dispose the session immediately — it can be reattached on reconnect.
	 */
	release(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;

		info.lastActivity = Date.now();
		this.startIdleTimer(sessionId);
	}

	/** Mark a session as actively generating (clears idle timer). */
	markGenerating(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;
		this.generatingSessions.add(sessionId);
		info.lastActivity = Date.now();
		this.clearIdleTimer(sessionId);
	}

	/** Mark a session as idle (starts idle timer). */
	markIdle(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;
		this.generatingSessions.delete(sessionId);
		info.lastActivity = Date.now();
		this.startIdleTimer(sessionId);
	}

	/** Check if there's room for another session. */
	hasCapacity(): boolean {
		return this.sessions.size < this.maxSessions;
	}

	/** Get pool stats. */
	stats(): { active: number; max: number } {
		return { active: this.sessions.size, max: this.maxSessions };
	}

	/**
	 * Dispose a single session: call dispose(), run cleanup, remove from map.
	 */
	dispose(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;

		this.clearIdleTimer(sessionId);
		this.generatingSessions.delete(sessionId);

		try {
			if (info.unsubscribe) info.unsubscribe();
		} catch {}
		try {
			if (info.detachCleanup) info.detachCleanup();
		} catch {}
		try {
			info.session.dispose();
		} catch (err) {
			console.error(`[session-pool] Error disposing session ${sessionId}:`, err);
		}

		this.sessions.delete(sessionId);
	}

	/**
	 * Gracefully shut down all sessions.
	 */
	async shutdown(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		// Clear all idle timers
		for (const [sessionId] of this.idleTimers) {
			this.clearIdleTimer(sessionId);
		}

		const sessionIds = Array.from(this.sessions.keys());
		if (sessionIds.length === 0) return;

		console.log(`[session-pool] Shutting down ${sessionIds.length} session(s)...`);

		for (const sessionId of sessionIds) {
			try {
				this.dispose(sessionId);
			} catch (err) {
				console.error(`[session-pool] Error during shutdown of session ${sessionId}:`, err);
			}
			this.emit("session-stopped", sessionId, "shutdown" as SessionStopReason);
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private startIdleTimer(sessionId: string): void {
		this.clearIdleTimer(sessionId);
		// Use aggressive timeout when pool is near capacity (>=80%)
		const highLoad = this.sessions.size / this.maxSessions >= 0.8;
		const timeout = highLoad ? this.aggressiveIdleTimeoutMs : this.idleTimeoutMs;
		this.idleTimers.set(
			sessionId,
			setTimeout(() => this.reapIdle(sessionId), timeout),
		);
	}

	private clearIdleTimer(sessionId: string): void {
		const timer = this.idleTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.idleTimers.delete(sessionId);
		}
	}

	/** Periodic sweep: reap sessions that have been idle too long. */
	private sweep(): void {
		const now = Date.now();
		const highLoad = this.sessions.size / this.maxSessions >= 0.8;
		const timeout = highLoad ? this.aggressiveIdleTimeoutMs : this.idleTimeoutMs;

		for (const [sessionId, info] of this.sessions) {
			if (this.generatingSessions.has(sessionId)) continue; // Never reap generating sessions
			if (
				now - info.lastActivity > timeout &&
				!this.idleTimers.has(sessionId)
			) {
				this.reapIdle(sessionId);
			}
		}
	}

	/** Dispose an idle session. */
	private reapIdle(sessionId: string): void {
		const info = this.sessions.get(sessionId);
		if (!info) return;
		if (this.generatingSessions.has(sessionId)) return; // Never reap generating sessions

		console.log(`[session-pool] Reaping idle session ${sessionId}`);
		this.dispose(sessionId);
		this.emit("session-stopped", sessionId, "idle" as SessionStopReason);
	}
}

export class SessionPoolCapacityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionPoolCapacityError";
	}
}
