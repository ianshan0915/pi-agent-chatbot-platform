/**
 * Memory Resolver: builds user memory as a Markdown string.
 *
 * Queries user memories from PostgreSQL, groups by category (pinned first),
 * and returns the content for injection via agentsFilesOverride.
 */

import type { Database } from "../db/types.js";

export interface ResolvedMemoryContent {
	/** Markdown content string, or null if no memories */
	content: string | null;
}

interface MemoryRow {
	content: string;
	category: string;
	pinned: boolean;
}

/**
 * Returns memory content as a string.
 *
 * Used by SdkBridge to inject memory via agentsFilesOverride
 * as a virtual file.
 */
export async function resolveMemoryContent(
	db: Database,
	userId: string,
): Promise<ResolvedMemoryContent> {
	const result = await db.query<MemoryRow>(
		`SELECT content, category, pinned FROM agent_memories
		 WHERE user_id = $1
		 ORDER BY pinned DESC, category, updated_at DESC
		 LIMIT 200`,
		[userId],
	);

	if (result.rows.length === 0) {
		return { content: null };
	}

	// Group memories by category, pinned first
	const pinned: string[] = [];
	const groups = new Map<string, string[]>();

	for (const row of result.rows) {
		if (row.pinned) {
			pinned.push(row.content);
		} else {
			const list = groups.get(row.category) || [];
			list.push(row.content);
			groups.set(row.category, list);
		}
	}

	// Build Markdown content
	const lines: string[] = [
		"# User Memory",
		"",
		"These are things the user has asked you to remember. Reference them naturally in conversation.",
		"",
	];

	if (pinned.length > 0) {
		lines.push("## Pinned");
		for (const item of pinned) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	const categoryLabels: Record<string, string> = {
		preference: "Preferences",
		fact: "Facts",
		instruction: "Instructions",
		general: "General",
	};

	for (const [category, items] of groups) {
		lines.push(`## ${categoryLabels[category] || category}`);
		for (const item of items) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}

	return { content: lines.join("\n") };
}
