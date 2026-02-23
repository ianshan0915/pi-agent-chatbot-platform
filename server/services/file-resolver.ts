/**
 * File Resolver: downloads user files to a temp dir for CLI injection.
 *
 * Takes an array of file IDs, validates ownership, downloads from StorageService
 * to a temp directory, and returns paths suitable for `--file <path>` CLI args.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Database, UserFileRow } from "../db/types.js";
import type { StorageService } from "./storage.js";

export interface ResolvedFiles {
	/** Absolute paths to downloaded files */
	filePaths: string[];
	/** Call to remove temp directory when session ends */
	cleanup: () => void;
}

export async function resolveFilesForUser(
	db: Database,
	storage: StorageService,
	userId: string,
	fileIds?: string[],
): Promise<ResolvedFiles> {
	if (!fileIds || fileIds.length === 0) {
		return { filePaths: [], cleanup: () => {} };
	}

	// Validate ownership — user can only access their own files
	const result = await db.query<UserFileRow>(
		`SELECT id, filename, storage_key FROM user_files
		 WHERE id = ANY($1) AND user_id = $2`,
		[fileIds, userId],
	);

	if (result.rows.length === 0) {
		return { filePaths: [], cleanup: () => {} };
	}

	const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-files-"));
	const filePaths: string[] = [];

	for (const file of result.rows) {
		try {
			const destPath = path.join(tmpBase, file.filename);
			// Ensure subdirectory exists (in case filename has no subdirs, this is a no-op on tmpBase)
			await fs.mkdir(path.dirname(destPath), { recursive: true });
			const data = await storage.download(file.storage_key);
			await fs.writeFile(destPath, data);
			filePaths.push(destPath);
		} catch (err) {
			console.error(`[file-resolver] Failed to resolve file "${file.filename}":`, err);
		}
	}

	const cleanup = () => {
		fs.rm(tmpBase, { recursive: true, force: true }).catch((err) => {
			console.error("[file-resolver] Failed to clean up temp dir:", err);
		});
	};

	return { filePaths, cleanup };
}
