/**
 * Human-friendly model name mappings.
 *
 * Translates raw model IDs (e.g. "claude-sonnet-4-20250514") into
 * display-friendly labels (e.g. "Claude Sonnet 4").
 */

export const MODEL_LABELS: Record<string, string> = {
	// Anthropic
	"claude-opus-4-6": "Claude Opus 4.6",
	"claude-opus-4-5": "Claude Opus 4.5",
	"claude-sonnet-4-6": "Claude Sonnet 4.6",
	"claude-sonnet-4-5": "Claude Sonnet 4.5",
	"claude-haiku-4-5": "Claude Haiku 4.5",
	// Google
	"gemini-2.5-flash": "Gemini 2.5 Flash",
	"gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
	"gemini-2.5-pro": "Gemini 2.5 Pro",
	"gemini-3-flash-preview": "Gemini 3 Flash",
	"gemini-3-pro-preview": "Gemini 3 Pro",
	"gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
	"gemini-3.1-pro-preview": "Gemini 3.1 Pro",
	// xAI
	"grok-4": "Grok 4",
	"grok-4-fast": "Grok 4 Fast",
	"grok-4-fast-non-reasoning": "Grok 4 Fast (NR)",
	"grok-4-1-fast": "Grok 4.1 Fast",
	"grok-4-1-fast-non-reasoning": "Grok 4.1 Fast (NR)",
	"grok-code-fast-1": "Grok Code Fast",
	// ZAI
	"glm-4.5": "GLM 4.5",
	"glm-4.5-air": "GLM 4.5 Air",
	"glm-4.5-flash": "GLM 4.5 Flash",
	"glm-4.5v": "GLM 4.5V",
	"glm-4.6": "GLM 4.6",
	"glm-4.6v": "GLM 4.6V",
	"glm-4.7": "GLM 4.7",
	"glm-4.7-flash": "GLM 4.7 Flash",
	"glm-5": "GLM 5",
	// MiniMax
	"MiniMax-M2": "MiniMax M2",
	"MiniMax-M2.1": "MiniMax M2.1",
	"MiniMax-M2.5": "MiniMax M2.5",
	"MiniMax-M2.5-highspeed": "MiniMax M2.5 HS",
};

/** Get a human-friendly label for a model ID, or the raw ID if unknown. */
export function getModelLabel(modelId: string): string {
	return MODEL_LABELS[modelId] || modelId;
}
