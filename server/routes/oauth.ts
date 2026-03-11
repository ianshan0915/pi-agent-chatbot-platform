/**
 * OAuth subscription management routes.
 *
 * Handles OAuth flow for subscription-based LLM providers (Anthropic Claude Pro, etc.)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { OAuthService } from "../services/oauth-service.js";
import type { CryptoService } from "../services/crypto.js";
import { getDatabase } from "../db/index.js";
import { generatePKCE } from "../utils/pkce.js";

// OAuth provider configurations
// OpenAI redirect URI: must match a URI registered with the OAuth client.
// The public CLI client only allows http://localhost:1455/auth/callback.
// For cloud deployment with a custom OAuth client, override via OAUTH_OPENAI_REDIRECT_URI.
const OPENAI_REDIRECT_URI =
	process.env.OAUTH_OPENAI_REDIRECT_URI || "http://localhost:1455/auth/callback";

const ANTIGRAVITY_REDIRECT_URI =
	process.env.OAUTH_ANTIGRAVITY_REDIRECT_URI || "http://localhost:51121/oauth-callback";

const OAUTH_PROVIDERS: Record<
	string,
	{
		clientId: string;
		clientSecret?: string;
		authorizeUrl: string;
		tokenUrl: string;
		redirectUri: string;
		scopes: string;
	}
> = {
	anthropic: {
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		authorizeUrl: "https://claude.ai/oauth/authorize",
		tokenUrl: "https://console.anthropic.com/v1/oauth/token",
		redirectUri: "https://console.anthropic.com/oauth/code/callback",
		scopes: "org:create_api_key user:profile user:inference",
	},
	"openai-codex": {
		clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
		authorizeUrl: "https://auth.openai.com/oauth/authorize",
		tokenUrl: "https://auth.openai.com/oauth/token",
		redirectUri: OPENAI_REDIRECT_URI,
		scopes: "openid profile email offline_access",
	},
	"google-antigravity": {
		// Requires OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET env vars.
		// Use the well-known public Cloud Shell / Gemini Code Assist OAuth client
		// credentials (see .env.development.example).
		clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || "",
		clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || "",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		redirectUri: ANTIGRAVITY_REDIRECT_URI,
		scopes: [
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		].join(" "),
	},
};

/** Discover the Antigravity project ID for the authenticated user. */
async function discoverAntigravityProject(accessToken: string): Promise<string> {
	const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};
	const body = JSON.stringify({
		metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
	});

	for (const endpoint of [
		"https://cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
	]) {
		try {
			const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, { method: "POST", headers, body });
			if (!res.ok) continue;
			const data = (await res.json()) as {
				cloudaicompanionProject?: string | { id?: string };
			};
			if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
				return data.cloudaicompanionProject;
			}
			if (
				data.cloudaicompanionProject &&
				typeof data.cloudaicompanionProject === "object" &&
				data.cloudaicompanionProject.id
			) {
				return data.cloudaicompanionProject.id;
			}
		} catch {
			// try next endpoint
		}
	}
	return DEFAULT_PROJECT_ID;
}

// Temporary storage for PKCE verifiers (in production, use Redis)
const pkceStorage = new Map<string, { verifier: string; userId: string; expiresAt: number }>();

// Clean up expired PKCE entries every 10 minutes
setInterval(() => {
	const now = Date.now();
	for (const [key, value] of pkceStorage.entries()) {
		if (value.expiresAt < now) {
			pkceStorage.delete(key);
		}
	}
}, 10 * 60 * 1000);

export function createOAuthRouter(crypto: CryptoService): Router {
	const router = Router();
	const db = getDatabase();
	// @ts-expect-error Database wrapper is compatible with Pool for OAuthService usage
	const oauthService = new OAuthService(db, crypto);

	// All routes require authentication
	router.use(requireAuth);

	// -----------------------------------------------------------------------
	// POST /:provider/start — Start OAuth flow for any provider
	// -----------------------------------------------------------------------
	router.post("/:provider/start", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			// Validate provider
			// @ts-expect-error Express 5 params type is string | string[]
			if (!(provider in OAUTH_PROVIDERS)) {
				res.status(400).json({ success: false, error: "Unsupported provider" });
				return;
			}

			const config = OAUTH_PROVIDERS[provider as keyof typeof OAUTH_PROVIDERS];

			// Generate PKCE challenge
			const { verifier, challenge } = await generatePKCE();

			// Store verifier temporarily (expires in 10 minutes)
			const stateKey = `${provider}-${userId}-${Date.now()}`;
			pkceStorage.set(stateKey, {
				verifier,
				userId,
				expiresAt: Date.now() + 10 * 60 * 1000,
			});

			// Build authorization URL
			const authParams = new URLSearchParams({
				client_id: config.clientId,
				response_type: "code",
				redirect_uri: config.redirectUri,
				scope: config.scopes,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: stateKey,
			});

			// Provider-specific parameters
			if (provider === "openai-codex") {
				authParams.set("codex_cli_simplified_flow", "true");
				authParams.set("id_token_add_organizations", "true");
				authParams.set("originator", "pi");
			} else if (provider === "google-antigravity") {
				authParams.set("access_type", "offline");
				authParams.set("prompt", "consent");
			}

			const authUrl = `${config.authorizeUrl}?${authParams.toString()}`;

			res.json({
				success: true,
				data: {
					authUrl,
					state: stateKey,
				},
			});
		} catch (err) {
			console.error(`[oauth] POST /:provider/start error:`, err);
			res.status(500).json({ success: false, error: "Failed to start OAuth flow" });
		}
	});

	// -----------------------------------------------------------------------
	// POST /:provider/callback — Handle OAuth callback with authorization code
	// -----------------------------------------------------------------------
	router.post("/:provider/callback", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const { code, state } = req.body;
			const userId = req.user!.userId;

			// Validate provider
			// @ts-expect-error Express 5 params type is string | string[]
			if (!(provider in OAUTH_PROVIDERS)) {
				res.status(400).json({ success: false, error: "Unsupported provider" });
				return;
			}

			if (!code || typeof code !== "string") {
				res.status(400).json({ success: false, error: "code is required" });
				return;
			}
			if (!state || typeof state !== "string") {
				res.status(400).json({ success: false, error: "state is required" });
				return;
			}

			// Retrieve and validate PKCE verifier
			const pkceData = pkceStorage.get(state);
			if (!pkceData) {
				res.status(400).json({ success: false, error: "Invalid or expired state" });
				return;
			}
			if (pkceData.userId !== userId) {
				res.status(403).json({ success: false, error: "State does not match user" });
				return;
			}

			// Clean up PKCE storage
			pkceStorage.delete(state);

			const config = OAUTH_PROVIDERS[provider as keyof typeof OAUTH_PROVIDERS];

			// Exchange code for tokens
			const tokenParams: Record<string, string> = {
				grant_type: "authorization_code",
				client_id: config.clientId,
				code: code,
				redirect_uri: config.redirectUri,
				code_verifier: pkceData.verifier,
			};
			if (config.clientSecret) {
				tokenParams.client_secret = config.clientSecret;
			}

			const tokenResponse = await fetch(config.tokenUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(tokenParams),
			});

			if (!tokenResponse.ok) {
				const error = await tokenResponse.text();
				console.error(`[oauth] Token exchange failed for ${provider}:`, error);
				res.status(400).json({ success: false, error: "Token exchange failed" });
				return;
			}

			const tokenData = (await tokenResponse.json()) as {
				access_token: string;
				refresh_token: string;
				expires_in: number;
			};

			// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
			const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

			// Build credentials object (with provider-specific extra fields)
			const credentials: Record<string, unknown> = {
				refresh: tokenData.refresh_token,
				access: tokenData.access_token,
				expires: expiresAt,
			};

			// For OpenAI Codex, extract accountId from the JWT
			if (provider === "openai-codex") {
				try {
					const parts = tokenData.access_token.split(".");
					if (parts.length === 3) {
						const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
						const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
						if (accountId) {
							credentials.accountId = accountId;
							console.log(`[oauth] OpenAI Codex accountId: ${accountId}`);
						}
					}
				} catch (e) {
					console.error("[oauth] Failed to extract accountId from OpenAI token:", e);
				}
			}

			// Antigravity requires project discovery after token exchange
			if (provider === "google-antigravity") {
				credentials.projectId = await discoverAntigravityProject(tokenData.access_token);
				console.log(`[oauth] Antigravity project: ${credentials.projectId}`);
			}

			// Store credentials
			await oauthService.storeCredentials(provider as any, credentials as any, { userId });

			res.json({
				success: true,
				data: {
					provider,
					expiresAt: new Date(expiresAt).toISOString(),
				},
			});
		} catch (err) {
			console.error(`[oauth] POST /:provider/callback error:`, err);
			res.status(500).json({ success: false, error: "Failed to complete OAuth flow" });
		}
	});

	// -----------------------------------------------------------------------
	// GET /:provider/status — Check if user has OAuth credentials for provider
	// -----------------------------------------------------------------------
	router.get("/:provider/status", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			const credentials = await oauthService.getCredentials(provider as any, { userId });

			if (!credentials) {
				res.json({
					success: true,
					data: {
						connected: false,
					},
				});
				return;
			}

			res.json({
				success: true,
				data: {
					connected: true,
					expiresAt: new Date(credentials.expires).toISOString(),
					expired: credentials.expires < Date.now(),
				},
			});
		} catch (err) {
			console.error(`[oauth] GET /:provider/status error:`, err);
			res.status(500).json({ success: false, error: "Failed to check OAuth status" });
		}
	});

	// -----------------------------------------------------------------------
	// DELETE /:provider — Disconnect OAuth for provider
	// -----------------------------------------------------------------------
	router.delete("/:provider", async (req: Request, res: Response) => {
		try {
			const { provider } = req.params;
			const userId = req.user!.userId;

			const deleted = await oauthService.deleteCredentials(provider as any, { userId });

			if (!deleted) {
				res.status(404).json({ success: false, error: "No OAuth credentials found" });
				return;
			}

			res.json({ success: true });
		} catch (err) {
			console.error(`[oauth] DELETE /:provider error:`, err);
			res.status(500).json({ success: false, error: "Failed to disconnect OAuth" });
		}
	});

	// -----------------------------------------------------------------------
	// GET / — List all OAuth connections for user
	// -----------------------------------------------------------------------
	router.get("/", async (req: Request, res: Response) => {
		try {
			const userId = req.user!.userId;

			const credentials = await oauthService.listCredentials({ userId });

			res.json({
				success: true,
				data: {
					credentials: credentials.map((cred) => ({
						provider: cred.provider,
						expiresAt: cred.expiresAt.toISOString(),
						expired: cred.expiresAt.getTime() < Date.now(),
						createdAt: cred.createdAt.toISOString(),
						updatedAt: cred.updatedAt.toISOString(),
					})),
				},
			});
		} catch (err) {
			console.error("[oauth] GET / error:", err);
			res.status(500).json({ success: false, error: "Failed to list OAuth credentials" });
		}
	});

	return router;
}
