/**
 * TenantBridge: tenant-aware agent bridge.
 *
 * Extends WsBridge to:
 * - Inject server-managed API keys from the database
 * - Use the ProcessPool for process lifecycle management
 * - Support WebSocket reconnection to existing processes
 * - Block client-side set_api_key (keys managed via REST)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { WebSocket } from "ws";
import type { CryptoService } from "./services/crypto.js";
import type { ProcessPool } from "./services/process-pool.js";
import type { Database, ProviderKeyRow } from "./db/types.js";
import { WsBridge, PROVIDER_ENV_MAP, type BridgeOptions } from "./ws-bridge.js";

export interface AuthUser {
	userId: string;
	teamId: string;
	email: string;
	role: string;
}

export interface TenantBridgeOptions extends BridgeOptions {
	user: AuthUser;
	sessionId?: string;
	processPool: ProcessPool;
	crypto: CryptoService;
	db: Database;
}

export class TenantBridge extends WsBridge {
	private user: AuthUser;
	private sessionId: string | undefined;
	private processPool: ProcessPool;
	private crypto: CryptoService;
	private db: Database;

	constructor(ws: WebSocket, options: TenantBridgeOptions) {
		super(ws, options);
		this.user = options.user;
		this.sessionId = options.sessionId;
		this.processPool = options.processPool;
		this.crypto = options.crypto;
		this.db = options.db;
	}

	/**
	 * Override start(): fetch and decrypt team API keys, then spawn or
	 * reattach to an existing process via the process pool.
	 */
	override start(): void {
		this.startAsync().catch((err) => {
			console.error("[tenant-bridge] Failed to start:", err);
			this.ws.close(1011, "Failed to initialize agent");
		});
	}

	private async startAsync(): Promise<void> {
		// 1. Fetch and decrypt provider keys for this team
		await this.injectTeamKeys();

		// 2. Check for existing process (reconnection)
		const existingSessionId = this.sessionId;
		if (existingSessionId) {
			const existing = this.processPool.get(existingSessionId);
			if (existing) {
				console.log(`[tenant-bridge] Reattaching to existing process for session ${existingSessionId}`);
				this.process = existing.process;
				this.processPool.touch(existingSessionId);
				this.wireUpProcess();
				this.wireUpWebSocket();
				return;
			}
		}

		// 3. Spawn new process via pool
		const sessionId = existingSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.sessionId = sessionId;

		const info = this.processPool.acquire({
			sessionId,
			userId: this.user.userId,
			teamId: this.user.teamId,
			spawnFn: () => this.createProcess(),
		});

		this.process = info.process;
		this.wireUpProcess();
		this.wireUpWebSocket();
	}

	/**
	 * Fetch provider_keys for the team, decrypt them, and inject into extraEnv.
	 */
	private async injectTeamKeys(): Promise<void> {
		const result = await this.db.query<ProviderKeyRow>(
			`SELECT * FROM provider_keys WHERE team_id = $1`,
			[this.user.teamId],
		);

		for (const row of result.rows) {
			try {
				const apiKey = this.crypto.decrypt({
					encryptedDek: row.encrypted_dek,
					encryptedData: row.encrypted_key,
					iv: row.iv,
					keyVersion: row.key_version,
				});

				const envVar = PROVIDER_ENV_MAP[row.provider] || `${row.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
				this.extraEnv[envVar] = apiKey;

				// Audit log: record decrypt
				await this.db.query(
					`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action)
					 VALUES ($1, $2, $3, 'decrypt')`,
					[this.user.teamId, this.user.userId, row.provider],
				);
			} catch (err) {
				console.error(`[tenant-bridge] Failed to decrypt key for provider ${row.provider}:`, err);
			}
		}
	}

	/**
	 * Create the child process (used by processPool.acquire's spawnFn).
	 * Mirrors WsBridge.spawnProcess() logic but returns the ChildProcess
	 * without wiring up I/O (the pool manages lifecycle).
	 */
	private createProcess(): ChildProcess {
		// Resolve command (same logic as WsBridge.resolveCommand)
		let command: string;
		let commandArgs: string[];

		if (process.env.PI_CLI_PATH) {
			command = "node";
			commandArgs = [process.env.PI_CLI_PATH];
		} else {
			const candidates = [
				path.resolve(import.meta.dirname, "../coding-agent/dist/cli.js"),
				path.resolve(process.cwd(), "../coding-agent/dist/cli.js"),
				path.resolve(process.cwd(), "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
			];

			const found = candidates.find((c) => existsSync(c));
			if (found) {
				command = "node";
				commandArgs = [found];
			} else {
				command = "pi";
				commandArgs = [];
			}
		}

		const args = [...commandArgs, "--mode", "rpc"];
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.args) args.push(...this.options.args);

		console.log(`[tenant-bridge] Spawning: ${command} ${args.join(" ")}`);

		return spawn(command, args, {
			cwd: this.options.cwd || process.cwd(),
			env: { ...process.env, ...this.extraEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	/**
	 * Wire up process stdout/stderr to WebSocket (similar to parent's spawnProcess).
	 */
	private wireUpProcess(): void {
		if (!this.process) return;

		// Forward stderr to server console
		this.process.stderr?.on("data", (data: Buffer) => {
			console.error(`[rpc stderr] ${data.toString().trimEnd()}`);
		});

		// Set up line reader for stdout → WebSocket
		this.rl = readline.createInterface({
			input: this.process.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line: string) => {
			if (this.closed) return;
			try {
				const parsed = JSON.parse(line);
				console.log(`[rpc→ws] ${parsed.type || "unknown"}${parsed.command ? ` (${parsed.command})` : ""}`);
				this.ws.send(line);
			} catch {
				// Non-JSON output, ignore
			}
		});

		// Handle process exit
		this.process.on("exit", (code: number | null, signal: string | null) => {
			console.log(`[rpc] Process exited (code=${code}, signal=${signal})`);
		});

		this.process.on("error", (err: Error) => {
			console.error(`[rpc] Process error: ${err.message}`);
			if (!this.closed) {
				this.ws.close(1011, "RPC process error");
			}
		});

		console.log("[tenant-bridge] Process wired up");
	}

	/**
	 * Wire up WebSocket message/close/error handlers.
	 */
	private wireUpWebSocket(): void {
		this.ws.on("message", (data) => {
			if (this.closed) return;
			const message = data.toString();
			try {
				const parsed = JSON.parse(message);

				// Block client-side API key setting
				if (parsed.type === "bridge_set_api_key") {
					this.handleSetApiKey(parsed);
					return;
				}

				// Forward to pi process stdin
				if (!this.process?.stdin) return;
				console.log(`[ws→rpc] ${parsed.type || "unknown"}${parsed.id ? ` (${parsed.id})` : ""}`);
				this.process.stdin.write(message + "\n");

				// Touch the process pool timer on activity
				if (this.sessionId) {
					this.processPool.touch(this.sessionId);
				}
			} catch {
				console.error("[tenant-bridge] Invalid JSON from WebSocket:", message);
			}
		});

		this.ws.on("close", () => {
			this.stop();
		});

		this.ws.on("error", (err) => {
			console.error("[tenant-bridge] WebSocket error:", err.message);
			this.stop();
		});
	}

	/**
	 * Override handleSetApiKey: block it. Keys are managed via REST API.
	 */
	protected override handleSetApiKey(parsed: any): void {
		const { id } = parsed;
		this.ws.send(JSON.stringify({
			id,
			type: "bridge_response",
			command: "bridge_set_api_key",
			success: false,
			error: "API keys are managed by your team admin via the Provider Keys settings.",
		}));
	}

	/**
	 * Override stop(): release the process back to the pool (starts idle timer)
	 * instead of killing it immediately.
	 */
	override stop(): void {
		if (this.closed) return;
		this.closed = true;

		// Detach readline but don't close stdin (process stays alive in pool)
		this.rl?.close();
		this.rl = null;

		// Release to pool — starts idle timer but keeps process alive
		if (this.sessionId) {
			this.processPool.release(this.sessionId);
		}

		console.log("[tenant-bridge] Released process to pool");
	}
}
