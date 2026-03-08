/**
 * Closure-based Agent Memory extension factory.
 *
 * Unlike the default export in `agent-memory.ts` (which reads process.env),
 * this factory captures the memory token and server port via closure so that
 * multiple sessions running in the same Node.js process each get their own
 * credentials — required for the in-process SDK bridge.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

export function createAgentMemoryExtension(
	memoryToken: string,
	serverPort: number,
): ExtensionFactory {
	return function agentMemoryExtension(pi: ExtensionAPI) {
		const baseUrl = `http://localhost:${serverPort}/api/memory/internal`;

		pi.registerTool({
			name: "memory_save",
			label: "Save Memory",
			description:
				"Save an important fact, preference, or instruction to persistent memory. " +
				"Use this when the user tells you something you should remember for future conversations, " +
				"such as their name, preferences, work context, or standing instructions. " +
				"Memories persist across all future chat sessions.",
			parameters: Type.Object({
				content: Type.String({
					description: "The memory to save. Be concise but complete — include enough context to be useful later.",
				}),
				category: Type.Optional(Type.Union([
					Type.Literal("preference"),
					Type.Literal("fact"),
					Type.Literal("instruction"),
					Type.Literal("general"),
				], {
					description: "Category: 'preference' for likes/dislikes/style, 'fact' for biographical/context info, 'instruction' for standing orders, 'general' for everything else.",
				})),
			}),
			async execute(_toolCallId, params) {
				const response = await fetch(`${baseUrl}/save`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Memory-Token": memoryToken,
					},
					body: JSON.stringify({
						content: params.content,
						category: params.category || "general",
					}),
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					throw new Error(`Memory save failed (${response.status}): ${body}`);
				}

				return {
					content: [{ type: "text", text: `Saved to memory: "${params.content}"` }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "memory_search",
			label: "Search Memory",
			description:
				"Search the user's persistent memory for previously saved facts, preferences, or instructions. " +
				"Use this when you need to recall something the user told you in a previous conversation, " +
				"or when the user asks 'what do you know about me?' or similar.",
			parameters: Type.Object({
				query: Type.String({
					description: "Search query to find relevant memories (uses full-text search).",
				}),
				limit: Type.Optional(Type.Number({
					description: "Max results to return (1-50, default 10).",
				})),
			}),
			async execute(_toolCallId, params) {
				const response = await fetch(`${baseUrl}/search`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Memory-Token": memoryToken,
					},
					body: JSON.stringify({
						query: params.query,
						limit: params.limit,
					}),
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					throw new Error(`Memory search failed (${response.status}): ${body}`);
				}

				const data = await response.json();
				const memories = data?.data?.memories ?? [];

				if (memories.length === 0) {
					return {
						content: [{ type: "text", text: `No memories found for: "${params.query}"` }],
						details: {},
					};
				}

				const formatted = memories
					.map((m: any, i: number) =>
						`${i + 1}. [${m.category}${m.pinned ? ", pinned" : ""}] ${m.content}`,
					)
					.join("\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: {},
				};
			},
		});
	};
}
