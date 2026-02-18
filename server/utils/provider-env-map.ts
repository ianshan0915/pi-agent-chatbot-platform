/** Provider name → environment variable name mapping for API keys. */
export const PROVIDER_ENV_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	huggingface: "HF_TOKEN",
	opencode: "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	"azure-openai": "AZURE_OPENAI_API_KEY",
	"google-gemini-cli": "GEMINI_API_KEY",
};

/** OAuth provider → environment variable name mapping. */
export const OAUTH_PROVIDER_ENV_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	"openai-codex": "OPENAI_API_KEY",
	"github-copilot": "ANTHROPIC_API_KEY", // GitHub Copilot uses Anthropic backend
	"google-gemini-cli": "GEMINI_API_KEY",
	"google-antigravity": "GEMINI_API_KEY",
};
