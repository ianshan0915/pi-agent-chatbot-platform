/**
 * SdkBridge: tenant-aware agent bridge using in-process AgentSession.
 *
 * Creates AgentSession objects directly via the SDK, calling SDK methods
 * for each WebSocket command and forwarding session events back to the
 * client. Benefits:
 * - No child process overhead
 * - Direct access to session state (model, thinking level, etc.)
 * - Shared event loop — better for multi-tenant server
 * - Closure-based extensions (no env var passing for credentials)
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WebSocket } from "ws";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	createAgentSession,
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionFactory,
	type ExtensionUIContext,
	type ExtensionCommandContextActions,
} from "@mariozechner/pi-coding-agent";
import type { AuthUser } from "./auth/types.js";

export interface BridgeOptions {
	/** Working directory for the agent */
	cwd?: string;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** System prompt text — replaces the default pi coding-assistant prompt */
	systemPrompt?: string;
	/** System prompt text — appended to the default prompt instead of replacing */
	appendSystemPrompt?: string;
}
import type { CryptoService } from "./services/crypto.js";
import type { SessionPool } from "./services/session-pool.js";
import type { StorageService } from "./services/storage.js";
import type { SessionStatusService } from "./services/session-status-service.js";
import type { OutputBufferService } from "./services/output-buffer.js";
import type { Database } from "./db/types.js";
import { AgentExecutor } from "./services/agent-executor.js";
import { resolveSkillsForUser, type ResolvedSkills } from "./services/skill-resolver.js";
import { resolveFilesForUser, type ResolvedFiles } from "./services/file-resolver.js";
import { resolveMemoryContent } from "./services/memory-resolver.js";
import { issueMemoryToken, revokeMemoryToken } from "./auth/memory-tokens.js";
import { envVarToProvider } from "./utils/reverse-provider-map.js";
import { createAgentMemoryExtension } from "./extensions/agent-memory-factory.js";
import braveSearchExtension from "./extensions/brave-search.js";
import pushToViewerExtension from "./extensions/push-to-viewer.js";

export interface SdkBridgeOptions extends BridgeOptions {
	user: AuthUser;
	sessionId?: string;
	sessionPool: SessionPool;
	crypto: CryptoService;
	db: Database;
	storage: StorageService;
	sessionStatusService: SessionStatusService;
	outputBufferService: OutputBufferService;
	/** Curated skill IDs from agent profile (undefined = all visible skills) */
	profileSkillIds?: string[];
	/** File IDs from agent profile to inject via --file args */
	profileFileIds?: string[];
	/** Agent profile ID for session metadata tracking */
	agentProfileId?: string;
	/** Port for internal API calls (memory extension) */
	serverPort: number;
}

export class SdkBridge {
	private ws: WebSocket;
	private options: SdkBridgeOptions;
	private user: AuthUser;
	private sessionId: string;
	private sessionPool: SessionPool;
	private crypto: CryptoService;
	private db: Database;
	private storage: StorageService;
	private sessionStatusService: SessionStatusService;
	private outputBufferService: OutputBufferService;

	// Session state
	private session: AgentSession | null = null;
	private authStorage: AuthStorage | null = null;
	private resourceLoader: DefaultResourceLoader | null = null;
	private resolvedSkills: ResolvedSkills | null = null;
	private resolvedFiles: ResolvedFiles | null = null;
	private memoryToken: string | null = null;
	private sessionModel: { id: string; provider: string | null } | null = null;
	private conversationHistory: Array<{ role: string; content: any }> | null = null;

	// Bridge state
	private closed = false;
	private detached = false;
	private ready = false;
	private sessionCreating = false;
	private pendingMessages: Array<{ raw: string; parsed: any }> = [];
	// Providers explicitly configured via team API keys or user OAuth (via setRuntimeApiKey).
	// Used to prefer these over auto-detected providers (e.g., AWS IAM → Bedrock) when
	// resolving the default model in sendSyntheticGetState().
	private configuredProviders = new Set<string>();
	private unsubscribeSession: (() => void) | null = null;

	// Extension UI pending promises (for forwarding UI requests to WS client)
	private pendingUIRequests = new Map<string, {
		resolve: (value: any) => void;
		reject: (reason: any) => void;
	}>();

	constructor(ws: WebSocket, options: SdkBridgeOptions) {
		this.ws = ws;
		this.options = options;
		this.user = options.user;
		this.sessionId = options.sessionId || randomUUID();
		this.sessionPool = options.sessionPool;
		this.crypto = options.crypto;
		this.db = options.db;
		this.storage = options.storage;
		this.sessionStatusService = options.sessionStatusService;
		this.outputBufferService = options.outputBufferService;
	}

	/**
	 * Start the bridge: register WebSocket handlers immediately, then
	 * async-initialize keys + skills + session.
	 */
	start(): void {
		this.wireUpWebSocket();

		this.startAsync().catch((err) => {
			console.error("[sdk-bridge] Failed to start:", err);
			this.ws.close(1011, "Failed to initialize agent");
		});
	}

	private async startAsync(): Promise<void> {
		// Check generating limit before proceeding
		const generatingCount = await this.sessionStatusService.getGeneratingCount(this.user.userId, this.db);
		if (generatingCount >= 3) {
			this.ws.close(4031, "Max 3 concurrent generating sessions");
			return;
		}

		// Run all async prep work in parallel
		const [envKeys, , , , memoryContent] = await Promise.all([
			// 1. Fetch and inject provider keys + OAuth credentials
			new AgentExecutor({ db: this.db, crypto: this.crypto, storage: this.storage })
				.buildEnv(this.user.userId, this.user.teamId),

			// 2. Resolve skills for this user (filtered by profile if set)
			resolveSkillsForUser(
				this.db, this.storage, this.user.userId, this.user.teamId,
				this.options.profileSkillIds,
			).then(skills => {
				this.resolvedSkills = skills;
				if (skills.skillPaths.length > 0) {
					console.log(`[sdk-bridge] Resolved ${skills.skillPaths.length} skill(s)`);
				}
			}).catch(err => {
				console.error("[sdk-bridge] Failed to resolve skills:", err);
			}),

			// 3. Resolve files from agent profile
			(this.options.profileFileIds && this.options.profileFileIds.length > 0
				? resolveFilesForUser(
					this.db, this.storage, this.user.userId,
					this.options.profileFileIds,
				).then(files => {
					this.resolvedFiles = files;
					if (files.filePaths.length > 0) {
						console.log(`[sdk-bridge] Resolved ${files.filePaths.length} file(s)`);
					}
				}).catch(err => {
					console.error("[sdk-bridge] Failed to resolve files:", err);
				})
				: Promise.resolve()
			),

			// 4. Fetch conversation history + session model for existing sessions
			(this.options.sessionId
				? Promise.all([
					this.db.query<{ role: string; content: any }>(
						`SELECT m.role, m.content FROM messages m
						 JOIN sessions s ON s.id = m.session_id
						 WHERE m.session_id = $1 AND s.user_id = $2
						 ORDER BY m.ordinal ASC LIMIT 200`,
						[this.options.sessionId, this.user.userId],
					).then(result => {
						if (result.rows.length > 0) {
							this.conversationHistory = result.rows;
							console.log(`[sdk-bridge] Fetched ${result.rows.length} history message(s)`);
						}
					}),
					this.db.query<{ model_id: string | null; provider: string | null }>(
						`SELECT model_id, provider FROM sessions
						 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
						[this.options.sessionId, this.user.userId],
					).then(result => {
						if (result.rows.length > 0 && result.rows[0].model_id) {
							this.sessionModel = {
								id: result.rows[0].model_id,
								provider: result.rows[0].provider,
							};
						}
					}),
				]).catch(err => {
					console.error("[sdk-bridge] Failed to fetch conversation history:", err);
				})
				: Promise.resolve()
			),

			// 5. Resolve user memories (content string, no temp file)
			resolveMemoryContent(this.db, this.user.userId)
				.catch(err => {
					console.error("[sdk-bridge] Failed to resolve memories:", err);
					return { content: null };
				}),
		]);

		// Issue memory token for the extension
		this.memoryToken = issueMemoryToken(this.user.userId, this.user.teamId);

		// Audit log provider key decryptions (non-blocking)
		const providers = Object.keys(envKeys);
		if (providers.length > 0) {
			const values = providers.map((_, i) => `($1, $2, $${i + 3}, 'decrypt')`).join(", ");
			this.db.query(
				`INSERT INTO provider_key_audit_log (team_id, user_id, provider, action) VALUES ${values}`,
				[this.user.teamId, this.user.userId, ...providers],
			).catch(() => {});
		}

		// Build AuthStorage with runtime API keys from env map
		this.authStorage = AuthStorage.inMemory();
		for (const [envVar, value] of Object.entries(envKeys)) {
			const provider = envVarToProvider(envVar);
			if (provider) {
				this.authStorage.setRuntimeApiKey(provider, value);
				this.configuredProviders.add(provider);
			}
		}

		// Build the system prompt
		let systemPrompt: string | undefined;
		let appendSystemPrompt: string | undefined;
		if (this.options.systemPrompt) {
			systemPrompt = this.options.systemPrompt;
		} else if (this.options.appendSystemPrompt) {
			appendSystemPrompt = this.options.appendSystemPrompt;
		}

		// Inject conversation history into append system prompt for continuity
		if (this.conversationHistory && this.conversationHistory.length > 0) {
			const historyBlock = this.formatConversationHistory(this.conversationHistory);
			if (systemPrompt) {
				systemPrompt = systemPrompt + "\n\n" + historyBlock;
			} else if (appendSystemPrompt) {
				appendSystemPrompt = appendSystemPrompt + "\n\n" + historyBlock;
			} else {
				appendSystemPrompt = historyBlock;
			}
			console.log(`[sdk-bridge] Injected ${this.conversationHistory.length} history messages into system prompt`);
		}

		// Build extension factories
		const extensionFactories: ExtensionFactory[] = [];

		// Brave Search extension
		if (process.env.BRAVE_SEARCH_API_KEY) {
			extensionFactories.push(braveSearchExtension);
		}

		// Push-to-viewer extension (always available)
		extensionFactories.push(pushToViewerExtension);

		// Agent memory extension (closure-based, captures token and port)
		if (this.memoryToken) {
			extensionFactories.push(
				createAgentMemoryExtension(this.memoryToken, this.options.serverPort),
			);
		}

		// Build agents files override for memory injection (virtual file, no temp file)
		const memContent = memoryContent?.content ?? null;
		const agentsFilesOverride = memContent
			? (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
				agentsFiles: [
					...base.agentsFiles,
					{ path: "MEMORY.md", content: memContent },
				],
			})
			: undefined;

		// Build file list for agents files override (profile files)
		let profileFilesOverride: typeof agentsFilesOverride | undefined;
		if (this.resolvedFiles && this.resolvedFiles.filePaths.length > 0) {
			const fileContents = await Promise.all(
				this.resolvedFiles.filePaths.map(async (filePath) => {
					const content = await fs.readFile(filePath, "utf-8");
					return { path: path.basename(filePath), content };
				}),
			);
			const baseOverride = agentsFilesOverride;
			profileFilesOverride = (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
				const withMemory = baseOverride ? baseOverride(base) : base;
				return {
					agentsFiles: [
						...withMemory.agentsFiles,
						...fileContents,
					],
				};
			};
		}

		const finalFilesOverride = profileFilesOverride || agentsFilesOverride;

		// Build ResourceLoader
		this.resourceLoader = new DefaultResourceLoader({
			cwd: this.options.cwd || process.cwd(),
			extensionFactories,
			additionalSkillPaths: this.resolvedSkills?.skillPaths,
			systemPrompt,
			appendSystemPrompt,
			agentsFilesOverride: finalFilesOverride,
			// Don't load user's global/project extensions/skills/themes
			noThemes: true,
		});
		await this.resourceLoader.reload();

		// Check for existing session in pool (reconnection)
		if (this.options.sessionId) {
			const existing = this.sessionPool.get(this.options.sessionId);
			if (existing && existing.userId === this.user.userId) {
				console.log(`[sdk-bridge] Reattaching to existing session ${this.options.sessionId}`);

				// Close previous bridge's listener
				if (existing.detachCleanup) {
					existing.detachCleanup();
					existing.detachCleanup = undefined;
				}

				this.session = existing.session;
				this.authStorage = existing.authStorage;
				this.resourceLoader = existing.resourceLoader as DefaultResourceLoader;
				this.sessionPool.touch(this.options.sessionId);

				// Flush buffered output
				try {
					const bufferedLines = await this.outputBufferService.flushOrdered(this.options.sessionId);
					if (bufferedLines.length > 0) {
						console.log(`[sdk-bridge] Sending ${bufferedLines.length} buffered line(s)`);
						for (const line of bufferedLines) {
							try { this.ws.send(line); } catch {}
						}
					}
				} catch (err) {
					console.error("[sdk-bridge] Failed to flush output buffer:", err);
				}

				// Notify client of reattachment
				try {
					this.ws.send(JSON.stringify({ type: "session_reattached", sessionId: this.options.sessionId }));
				} catch {}

				// Subscribe to events and forward to WS
				this.subscribeToSession();
				this.detached = false;
				this.ready = true;
				this.flushPendingMessages();

				// Register owner for SSE fan-out
				this.sessionStatusService.registerOwner(this.options.sessionId, this.user.userId);
				return;
			} else if (existing) {
				console.warn(`[sdk-bridge] User ${this.user.userId} tried to reattach to session owned by ${existing.userId}`);
			}
		}

		// Defer session creation until first user message (lazy spawn)
		this.ready = true;

		// Flush any messages that arrived during startAsync() through the
		// normal dispatch path (handles get_state, lazy creation, etc.)
		if (this.pendingMessages.length > 0) {
			const buffered = this.pendingMessages;
			this.pendingMessages = [];
			for (const { parsed } of buffered) {
				this.dispatchCommand(parsed);
			}
		}

		try {
			this.ws.send(JSON.stringify({ type: "bridge_ready", sessionId: this.sessionId }));
		} catch {}
	}

	/**
	 * Lazily create the AgentSession on first user message.
	 */
	private async createSessionLazy(): Promise<void> {
		if (this.session || this.sessionCreating) return;
		this.sessionCreating = true;

		const modelRegistry = new ModelRegistry(this.authStorage!);

		// Resolve the model — prefer user's explicit choice over DB fallback
		let model = undefined;
		const modelId = this.options.model && this.options.model !== "loading..."
			? this.options.model
			: this.sessionModel?.id ?? undefined;
		const provider = this.options.provider || this.sessionModel?.provider || undefined;

		if (modelId && provider) {
			model = modelRegistry.find(provider, modelId);
			if (!model) {
				console.warn(`[sdk-bridge] Model ${provider}/${modelId} not found in registry, using default`);
			}
		}

		// If no model resolved, prefer a model from explicitly configured providers
		// over auto-detected ones (e.g., AWS IAM → Bedrock)
		if (!model) {
			const available = modelRegistry.getAvailable();
			if (available.length > 0) {
				const configuredModel = available.find(
					(m) => this.configuredProviders.has(m.provider),
				);
				model = configuredModel ?? available[0];
			}
		}

		const { session, extensionsResult } = await createAgentSession({
			cwd: this.options.cwd || process.cwd(),
			authStorage: this.authStorage!,
			modelRegistry,
			model,
			resourceLoader: this.resourceLoader!,
			sessionManager: SessionManager.inMemory(this.options.cwd || process.cwd()),
			settingsManager: SettingsManager.inMemory(),
		});

		this.session = session;

		// Bind extensions with a UI context that forwards to WS
		await session.bindExtensions({
			uiContext: this.createUIContext(),
			commandContextActions: this.createCommandContextActions(),
			shutdownHandler: () => {
				console.log("[sdk-bridge] Extension requested shutdown");
				this.stop();
			},
			onError: (err) => {
				console.error("[sdk-bridge] Extension error:", err);
			},
		});

		// Store in session pool
		this.sessionPool.acquire({
			sessionId: this.sessionId,
			userId: this.user.userId,
			teamId: this.user.teamId,
			session,
			resourceLoader: this.resourceLoader!,
			authStorage: this.authStorage!,
		});

		// Register owner and set initial status
		this.sessionStatusService.registerOwner(this.sessionId, this.user.userId);
		this.sessionStatusService.setStatus(this.sessionId, "idle", this.db);

		// Subscribe to events
		this.subscribeToSession();

		this.sessionCreating = false;
		console.log(`[sdk-bridge] Session created: ${this.sessionId} (model: ${session.model?.provider}/${session.model?.id})`);

		// Push model state to client so it knows the real model after lazy creation.
		// Skip if pending messages include a set_model/cycle_model — those will set the
		// final model and a premature state_update would clobber the client's optimistic
		// model selection.
		const hasPendingModelChange = this.pendingMessages.some(
			({ parsed }) => parsed.type === "set_model" || parsed.type === "cycle_model",
		);
		if (session.model && !hasPendingModelChange) {
			try {
				this.ws.send(JSON.stringify({
					type: "state_update",
					model: { id: session.model.id, provider: session.model.provider, name: session.model.name, reasoning: (session.model as any).reasoning },
				}));
			} catch {}
		}
	}

	/**
	 * Subscribe to AgentSession events and forward them to WebSocket.
	 */
	private subscribeToSession(): void {
		if (!this.session) return;

		// Unsubscribe previous listener if any
		this.unsubscribeSession?.();

		this.unsubscribeSession = this.session.subscribe((event: AgentSessionEvent) => {
			// Track status changes
			if (event.type === "agent_start" || event.type === "turn_start") {
				this.sessionPool.markGenerating(this.sessionId);
				this.sessionStatusService.setStatus(this.sessionId, "generating", this.db);
			} else if (event.type === "turn_end") {
				this.sessionPool.markIdle(this.sessionId);
				this.sessionStatusService.setStatus(this.sessionId, "idle", this.db);
			}

			// Serialize event to JSON line (same format as RPC mode)
			const line = JSON.stringify(event);

			// Detached mode: buffer to DB
			if (this.detached) {
				this.outputBufferService.append(this.sessionId, line).catch(() => {});
				// Persist message_end events for reconnection
				if (event.type === "message_end") {
					this.persistDetachedMessage(line);
				}
				return;
			}

			// Normal mode: forward to WebSocket
			if (this.closed) return;
			try {
				this.ws.send(line);
			} catch {
				// WS send error, ignore
			}
		});
	}

	/**
	 * Wire up WebSocket message/close/error handlers.
	 */
	private wireUpWebSocket(): void {
		this.ws.on("message", (data) => {
			if (this.closed) return;
			const raw = data.toString();
			try {
				const parsed = JSON.parse(raw);

				// Bridge-level commands handled regardless of ready/session state
				if (parsed.type === "bridge_set_api_key") {
					this.handleSetApiKey(parsed);
					return;
				}
				if (parsed.type === "extension_ui_response") {
					this.handleExtensionUIResponse(parsed);
					return;
				}

				// Buffer messages until async startup is done
				if (!this.ready) {
					this.pendingMessages.push({ raw, parsed });
					return;
				}

				this.dispatchCommand(parsed);
			} catch {
				console.error("[sdk-bridge] Invalid JSON from WebSocket:", raw);
			}
		});

		this.ws.on("close", () => {
			if (this.sessionId && this.sessionPool.get(this.sessionId)) {
				this.detach();
			} else {
				this.stop();
			}
		});

		this.ws.on("error", (err) => {
			console.error("[sdk-bridge] WebSocket error:", err.message);
			if (this.sessionId && this.sessionPool.get(this.sessionId)) {
				this.detach();
			} else {
				this.stop();
			}
		});
	}

	/**
	 * Central command dispatch — single routing path for all commands
	 * after startup is complete (ready = true).
	 *
	 * Routes commands through three tiers:
	 * 1. Session exists → direct SDK call via handleCommand()
	 * 2. No session, read-only query (get_state) → synthetic response
	 * 3. No session, mutation (prompt, etc.) → queue + lazy session creation
	 */
	private dispatchCommand(parsed: any): void {
		// Session exists — handle directly
		if (this.session) {
			this.handleCommand(parsed);
			this.sessionPool.touch(this.sessionId);
			return;
		}

		// No session — handle read-only queries without creating one
		if (parsed.type === "get_state") {
			this.sendSyntheticGetState(parsed.id);
			return;
		}

		// Queue the command and trigger lazy session creation (once)
		this.pendingMessages.push({ raw: JSON.stringify(parsed), parsed });
		if (!this.sessionCreating) {
			this.createSessionLazy().then(() => {
				this.flushPendingMessages();
			}).catch((err) => {
				console.error("[sdk-bridge] Failed to create session:", err);
				this.ws.close(1011, "Failed to create agent session");
			});
		}
	}

	/**
	 * Map incoming WebSocket commands to AgentSession SDK calls.
	 */
	private handleCommand(parsed: any): void {
		if (!this.session) return;
		const { id, type } = parsed;

		switch (type) {
			case "prompt":
				this.handlePrompt(parsed);
				break;

			case "steer":
				this.session.steer(parsed.message || parsed.text, parsed.images).catch((err) => {
					console.error("[sdk-bridge] steer error:", err);
				});
				break;

			case "follow_up":
				this.session.followUp(parsed.message || parsed.text, parsed.images).catch((err) => {
					console.error("[sdk-bridge] follow_up error:", err);
				});
				break;

			case "abort":
				this.session.abort().catch((err) => {
					console.error("[sdk-bridge] abort error:", err);
				});
				break;

			case "new_session":
				this.session.newSession().then((completed) => {
					this.sendResponse(id, { completed });
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "get_state":
				this.sendGetStateResponse(id);
				break;

			case "set_model": {
				const model = this.session.modelRegistry.find(parsed.provider, parsed.modelId);
				if (model) {
					this.session.setModel(model).then(() => {
						this.sendResponse(id, { model: { id: model.id, provider: model.provider, name: model.name, reasoning: (model as any).reasoning } });
					}).catch((err) => {
						this.sendError(id, err.message);
					});
				} else {
					this.sendError(id, `Model not found: ${parsed.provider}/${parsed.modelId}`);
				}
				break;
			}

			case "cycle_model":
				this.session.cycleModel(parsed.direction).then((result) => {
					if (result) {
						this.sendResponse(id, {
							model: { id: result.model.id, provider: result.model.provider, name: result.model.name, reasoning: (result.model as any).reasoning },
							thinkingLevel: result.thinkingLevel,
						});
					} else {
						this.sendResponse(id, null);
					}
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "get_available_models": {
				const models = this.session.modelRegistry.getAvailable().map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					reasoning: (m as any).reasoning,
				}));
				this.sendResponse(id, models);
				break;
			}

			case "set_thinking_level":
				this.session.setThinkingLevel(parsed.level as ThinkingLevel);
				this.sendResponse(id, { thinkingLevel: this.session.thinkingLevel });
				break;

			case "cycle_thinking_level": {
				const level = this.session.cycleThinkingLevel();
				this.sendResponse(id, level ? { thinkingLevel: level } : null);
				break;
			}

			case "set_steering_mode":
				this.session.setSteeringMode(parsed.mode);
				this.sendResponse(id, { steeringMode: this.session.steeringMode });
				break;

			case "set_follow_up_mode":
				this.session.setFollowUpMode(parsed.mode);
				this.sendResponse(id, { followUpMode: this.session.followUpMode });
				break;

			case "compact":
				this.session.compact(parsed.customInstructions).then((result) => {
					this.sendResponse(id, result);
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "set_auto_compaction":
				this.session.setAutoCompactionEnabled(parsed.enabled);
				this.sendResponse(id, { enabled: this.session.autoCompactionEnabled });
				break;

			case "set_auto_retry":
				this.session.setAutoRetryEnabled(parsed.enabled);
				this.sendResponse(id, { enabled: this.session.autoRetryEnabled });
				break;

			case "abort_retry":
				this.session.abortRetry();
				this.sendResponse(id, { aborted: true });
				break;

			case "bash":
				this.session.executeBash(parsed.command).then((result) => {
					this.sendResponse(id, result);
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "abort_bash":
				this.session.abortBash();
				this.sendResponse(id, { aborted: true });
				break;

			case "get_session_stats":
				this.sendResponse(id, this.session.getSessionStats());
				break;

			case "export_html":
				this.session.exportToHtml(parsed.outputPath).then((outputPath) => {
					this.sendResponse(id, { outputPath });
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "fork":
				this.session.fork(parsed.entryId).then((result) => {
					this.sendResponse(id, result);
				}).catch((err) => {
					this.sendError(id, err.message);
				});
				break;

			case "get_fork_messages":
				this.sendResponse(id, this.session.getUserMessagesForForking());
				break;

			case "get_last_assistant_text":
				this.sendResponse(id, { text: this.session.getLastAssistantText() ?? null });
				break;

			case "set_session_name":
				this.session.setSessionName(parsed.name);
				this.sendResponse(id, { name: this.session.sessionName });
				break;

			case "get_messages":
				this.sendResponse(id, this.session.messages);
				break;

			case "get_commands":
				this.sendResponse(id, this.session.resourceLoader.getExtensions().extensions.flatMap(ext =>
					Array.from(ext.commands.values()).map(cmd => ({
						name: cmd.name,
						description: cmd.description,
					}))
				));
				break;

			default:
				if (process.env.LOG_LEVEL === "debug") {
					console.log(`[sdk-bridge] Unhandled command type: ${type}`);
				}
		}
	}

	/**
	 * Handle a prompt command — fire and forget with catch (same as RPC mode).
	 */
	private handlePrompt(parsed: any): void {
		if (!this.session) return;

		const { id } = parsed;
		const text: string = parsed.message || parsed.text || parsed.prompt || "";
		const images = parsed.images;
		const streamingBehavior = parsed.streamingBehavior;

		// Fire and forget — send immediate acknowledgment (same as RPC mode)
		this.session.prompt(text, {
			images,
			streamingBehavior,
			source: "rpc",
		}).catch((err) => {
			console.error("[sdk-bridge] prompt error:", err);
			// Send error event to client
			try {
				this.ws.send(JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `Error: ${err.message}` }],
						stopReason: "error",
						errorMessage: err.message,
					},
				}));
			} catch {}
		});

		// Immediate acknowledgment so client's sendCommand() resolves
		if (id) {
			this.sendResponse(id, { command: "prompt", success: true });
		}
	}

	/**
	 * Send a synthetic get_state response when no session exists yet.
	 */
	private sendSyntheticGetState(requestId: string): void {
		const optModel = this.options.model && this.options.model !== "loading..."
			? this.options.model : null;
		let model: { id: string; provider: string | null; name?: string; reasoning?: boolean } | null = null;

		// Try to resolve full model info from registry (includes reasoning, name, etc.)
		if (this.authStorage) {
			const registry = new ModelRegistry(this.authStorage);
			if (optModel && this.options.provider) {
				const found = registry.find(this.options.provider, optModel);
				if (found) {
					model = { id: found.id, provider: found.provider, name: found.name, reasoning: (found as any).reasoning };
				}
			}
			if (!model && this.sessionModel?.id && this.sessionModel?.provider) {
				const found = registry.find(this.sessionModel.provider, this.sessionModel.id);
				if (found) {
					model = { id: found.id, provider: found.provider, name: found.name, reasoning: (found as any).reasoning };
				}
			}
			// Fallback: just id+provider without reasoning
			if (!model && optModel) {
				model = { id: optModel, provider: this.options.provider || null };
			} else if (!model && this.sessionModel) {
				model = { id: this.sessionModel.id, provider: this.sessionModel.provider };
			}
			// If no model known yet, resolve the default from available providers.
			// On AWS, getAvailable() includes auto-detected Bedrock models (from IAM credentials).
			// Prefer models from explicitly configured providers (team keys / user OAuth).
			if (!model) {
				const available = registry.getAvailable();
				if (available.length > 0) {
					const configuredModel = available.find(
						(m) => this.configuredProviders.has(m.provider),
					);
					const chosen = configuredModel ?? available[0];
					model = { id: chosen.id, provider: chosen.provider, name: chosen.name, reasoning: (chosen as any).reasoning };
				}
			}
		} else {
			// No authStorage yet — fall back to bare id+provider
			if (optModel) {
				model = { id: optModel, provider: this.options.provider || null };
			} else if (this.sessionModel) {
				model = { id: this.sessionModel.id, provider: this.sessionModel.provider };
			}
		}

		this.ws.send(JSON.stringify({
			id: requestId,
			type: "response",
			data: {
				model,
				thinkingLevel: "off",
				isStreaming: false,
			},
		}));
	}

	/**
	 * Send a get_state response from the live session.
	 */
	private sendGetStateResponse(requestId: string): void {
		if (!this.session) {
			this.sendSyntheticGetState(requestId);
			return;
		}

		const sessionModel = this.session.model;
		const model = sessionModel
			? { id: sessionModel.id, provider: sessionModel.provider, name: sessionModel.name, reasoning: (sessionModel as any).reasoning }
			: null;
		this.sendResponse(requestId, {
			model,
			thinkingLevel: this.session.thinkingLevel,
			isStreaming: this.session.isStreaming,
			isCompacting: this.session.isCompacting,
			steeringMode: this.session.steeringMode,
			followUpMode: this.session.followUpMode,
			sessionFile: this.session.sessionFile,
			sessionId: this.session.sessionId,
			sessionName: this.session.sessionName,
			autoCompactionEnabled: this.session.autoCompactionEnabled,
			messageCount: this.session.messages.length,
			pendingMessageCount: this.session.pendingMessageCount,
		});
	}

	// =========================================================================
	// Response helpers
	// =========================================================================

	private sendResponse(requestId: string, data: any): void {
		try {
			this.ws.send(JSON.stringify({ id: requestId, type: "response", data }));
		} catch {}
	}

	private sendError(requestId: string, error: string): void {
		try {
			this.ws.send(JSON.stringify({ id: requestId, type: "error", error }));
		} catch {}
	}

	// =========================================================================
	// Extension UI context (forward UI requests to WS client)
	// =========================================================================

	private createUIContext(): ExtensionUIContext {
		// Create a minimal UI context — extensions in a headless server
		// environment don't get interactive UI, but we forward requests
		// to the WebSocket client.
		const requestId = () => randomUUID();

		return {
			select: async (title, options, opts) => {
				const id = requestId();
				try {
					this.ws.send(JSON.stringify({
						type: "extension_ui_request",
						id,
						method: "select",
						title,
						options,
						opts,
					}));
					return await this.waitForUIResponse(id, opts?.timeout);
				} catch {
					return undefined;
				}
			},
			confirm: async (title, message, opts) => {
				const id = requestId();
				try {
					this.ws.send(JSON.stringify({
						type: "extension_ui_request",
						id,
						method: "confirm",
						title,
						message,
						opts,
					}));
					return (await this.waitForUIResponse(id, opts?.timeout)) ?? false;
				} catch {
					return false;
				}
			},
			input: async (title, placeholder, opts) => {
				const id = requestId();
				try {
					this.ws.send(JSON.stringify({
						type: "extension_ui_request",
						id,
						method: "input",
						title,
						placeholder,
						opts,
					}));
					return await this.waitForUIResponse(id, opts?.timeout);
				} catch {
					return undefined;
				}
			},
			notify: (message, notifType) => {
				try {
					this.ws.send(JSON.stringify({
						type: "extension_ui_request",
						method: "notify",
						message,
						notifType,
					}));
				} catch {}
			},
			// No-ops for server environment
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as any,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => {},
			get theme(): any { return {}; },
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	private createCommandContextActions(): ExtensionCommandContextActions {
		return {
			waitForIdle: async () => {
				// Wait for session to stop streaming
				if (this.session && this.session.isStreaming) {
					await new Promise<void>((resolve) => {
						const unsub = this.session!.subscribe((event) => {
							if (event.type === "turn_end" || event.type === "agent_end") {
								unsub();
								resolve();
							}
						});
					});
				}
			},
			newSession: async (options) => {
				const result = await this.session!.newSession(options);
				return { cancelled: !result };
			},
			fork: async (entryId) => {
				const result = await this.session!.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.session!.navigateTree(targetId, options);
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const result = await this.session!.switchSession(sessionPath);
				return { cancelled: !result };
			},
			reload: async () => {
				await this.session!.reload();
			},
		};
	}

	private waitForUIResponse(id: string, timeoutMs?: number): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
					this.pendingUIRequests.delete(id);
					resolve(undefined);
				}, timeoutMs)
				: null;

			this.pendingUIRequests.set(id, {
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					this.pendingUIRequests.delete(id);
					resolve(value);
				},
				reject: (reason) => {
					if (timer) clearTimeout(timer);
					this.pendingUIRequests.delete(id);
					reject(reason);
				},
			});
		});
	}

	private handleExtensionUIResponse(parsed: any): void {
		const pending = this.pendingUIRequests.get(parsed.id);
		if (pending) {
			pending.resolve(parsed.result);
		}
	}

	// =========================================================================
	// Utility methods
	// =========================================================================

	private handleSetApiKey(parsed: any): void {
		const { id } = parsed;
		try {
			this.ws.send(JSON.stringify({
				id,
				type: "bridge_response",
				command: "bridge_set_api_key",
				success: false,
				error: "API keys are managed by your team admin via the Provider Keys settings.",
			}));
		} catch {}
	}

	/**
	 * Flush queued commands after session creation.
	 * Called only from createSessionLazy() callback when session is ready.
	 */
	private flushPendingMessages(): void {
		if (this.pendingMessages.length === 0 || !this.session) return;
		const queued = this.pendingMessages;
		this.pendingMessages = [];
		for (const { parsed } of queued) {
			this.handleCommand(parsed);
		}
	}

	private formatConversationHistory(rows: Array<{ role: string; content: any }>): string {
		const lines: string[] = ["## Previous Conversation", ""];
		for (const row of rows) {
			const label = row.role === "user" || row.role === "user-with-attachments" ? "User" : "Assistant";
			const text = this.extractTextFromContent(row.content);
			if (text) {
				lines.push(`${label}: ${text}`);
			}
		}
		return lines.join("\n");
	}

	private extractTextFromContent(content: any): string {
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text || "")
				.join(" ")
				.trim();
		}
		return "";
	}

	/**
	 * Persist a message_end event to DB during detached mode.
	 */
	private persistDetachedMessage(line: string): void {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type !== "message_end" || !parsed.message) return;

			const msg = parsed.message;
			const role = msg.role || "assistant";
			const content = msg.content;
			if (!content) return;

			const contentJson = JSON.stringify(content);
			const usageJson = msg.usage ? JSON.stringify(msg.usage) : null;

			this.db.query(
				`INSERT INTO messages (id, session_id, ordinal, role, content, stop_reason, usage, created_at)
				 VALUES ($1, $2, (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM messages WHERE session_id = $2),
				         $3, $4::jsonb, $5, $6::jsonb, NOW())
				 ON CONFLICT (session_id, ordinal) DO NOTHING`,
				[
					randomUUID(),
					this.sessionId,
					role,
					contentJson,
					msg.stopReason ?? null,
					usageJson,
				],
			).then(() => {
				this.db.query(
					`UPDATE sessions SET message_count = message_count + 1, last_modified = NOW() WHERE id = $1`,
					[this.sessionId],
				).catch(() => {});
			}).catch((err) => {
				console.error("[sdk-bridge] Failed to persist detached message:", err);
			});
		} catch {
			// Non-critical
		}
	}

	/**
	 * Detach from WebSocket but keep session alive.
	 */
	private detach(): void {
		if (this.detached) return;
		this.detached = true;

		const sessionInfo = this.sessionPool.get(this.sessionId);

		// Store cleanup callback for reattaching bridges
		if (sessionInfo) {
			const unsub = this.unsubscribeSession;
			sessionInfo.detachCleanup = () => {
				unsub?.();
			};
		}

		this.sessionPool.release(this.sessionId);

		console.log(`[sdk-bridge] Detaching — session stays alive for ${this.sessionId}`);
	}

	/**
	 * Permanent shutdown: clean up everything.
	 */
	stop(): void {
		if (this.closed) return;
		this.closed = true;

		// Unsubscribe from events
		this.unsubscribeSession?.();
		this.unsubscribeSession = null;

		// Release session from pool
		if (this.sessionId) {
			this.sessionPool.release(this.sessionId);
			this.sessionStatusService.setStatus(this.sessionId, "suspended", this.db);
		}

		// Clean up resolved skills temp directory
		this.resolvedSkills?.cleanup();
		this.resolvedSkills = null;

		// Clean up resolved files temp directory
		this.resolvedFiles?.cleanup();
		this.resolvedFiles = null;

		// Revoke memory token
		revokeMemoryToken(this.memoryToken);
		this.memoryToken = null;

		// Reject any pending UI requests
		for (const [, pending] of this.pendingUIRequests) {
			pending.reject(new Error("Bridge stopped"));
		}
		this.pendingUIRequests.clear();

		console.log("[sdk-bridge] Stopped and cleaned up");
	}
}
