/**
 * Custom message types and renderers for the coding agent web UI.
 *
 * Mirrors the pattern from web-ui/example but kept minimal for now.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage } from "./web-ui/index.js";
import { defaultConvertToLlm } from "./web-ui/index.js";

/**
 * Custom message transformer — currently just passes through to default.
 * Add custom message type handling here as needed.
 */
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	return defaultConvertToLlm(messages);
}
