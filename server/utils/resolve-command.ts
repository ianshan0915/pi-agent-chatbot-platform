/**
 * Resolve the pi CLI command path.
 *
 * Priority: PI_CLI_PATH env var → local monorepo → npm package → global `pi`.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolvePiCommand(): { command: string; commandArgs: string[] } {
	if (process.env.PI_CLI_PATH) {
		return { command: "node", commandArgs: [process.env.PI_CLI_PATH] };
	}

	const candidates = [
		path.resolve(__dirname, "../../coding-agent/dist/cli.js"),
		path.resolve(process.cwd(), "../coding-agent/dist/cli.js"),
		path.resolve(process.cwd(), "node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
	];

	const found = candidates.find((c) => existsSync(c));
	if (found) {
		return { command: "node", commandArgs: [found] };
	}

	return { command: "pi", commandArgs: [] };
}
