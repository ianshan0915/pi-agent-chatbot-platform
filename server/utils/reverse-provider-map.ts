/**
 * Reverse mapping from environment variable names to provider identifiers.
 *
 * The platform's `buildEnv()` (in agent-executor.ts) maps provider names to
 * env var names (e.g. "anthropic" -> "ANTHROPIC_API_KEY") when spawning RPC
 * processes. With the SDK migration, we instead call
 * `authStorage.setRuntimeApiKey(provider, key)` — so we need the reverse map
 * to convert env var names back to provider names.
 *
 * Sources: PROVIDER_ENV_MAP and OAUTH_PROVIDER_ENV_MAP from provider-env-map.ts.
 */

import { PROVIDER_ENV_MAP, OAUTH_PROVIDER_ENV_MAP } from "./provider-env-map.js";

/**
 * Pre-built reverse map: env var name -> provider name.
 *
 * When multiple providers map to the same env var (e.g. "google" and
 * "google-gemini-cli" both map to "GEMINI_API_KEY"), the first provider
 * wins. PROVIDER_ENV_MAP entries take priority over OAUTH_PROVIDER_ENV_MAP.
 */
const ENV_VAR_TO_PROVIDER: Record<string, string> = {};

// Build reverse map from PROVIDER_ENV_MAP (primary source)
for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
	if (!(envVar in ENV_VAR_TO_PROVIDER)) {
		ENV_VAR_TO_PROVIDER[envVar] = provider;
	}
}

// OAUTH_PROVIDER_ENV_MAP entries only fill gaps not already covered
for (const [provider, envVar] of Object.entries(OAUTH_PROVIDER_ENV_MAP)) {
	if (!(envVar in ENV_VAR_TO_PROVIDER)) {
		ENV_VAR_TO_PROVIDER[envVar] = provider;
	}
}

/**
 * Map an environment variable name back to a provider identifier.
 *
 * @example
 * envVarToProvider("ANTHROPIC_API_KEY") // "anthropic"
 * envVarToProvider("OPENAI_API_KEY")    // "openai"
 * envVarToProvider("GEMINI_API_KEY")    // "google"
 * envVarToProvider("UNKNOWN_KEY")       // null
 */
export function envVarToProvider(envVar: string): string | null {
	return ENV_VAR_TO_PROVIDER[envVar] ?? null;
}
