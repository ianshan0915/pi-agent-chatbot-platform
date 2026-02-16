/**
 * StorageService: abstraction for binary file storage.
 *
 * Phase 3 provides a local filesystem implementation.
 * S3 backend deferred to Phase 5.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface StorageService {
	upload(key: string, data: Buffer, contentType?: string): Promise<void>;
	download(key: string): Promise<Buffer>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
	/** List all keys under a given prefix (e.g. "skills/owner/name/") */
	listByPrefix(prefix: string): Promise<string[]>;
	/** Recursively delete all files under a given prefix */
	deleteByPrefix(prefix: string): Promise<void>;
}

const DEFAULT_BASE_DIR = "./data/storage";

export class LocalFsStorageService implements StorageService {
	private baseDir: string;

	constructor(baseDir?: string) {
		this.baseDir = path.resolve(baseDir || DEFAULT_BASE_DIR);
	}

	private resolvePath(key: string): string {
		const resolved = path.resolve(this.baseDir, key);
		// Prevent path traversal
		if (!resolved.startsWith(this.baseDir)) {
			throw new Error("Invalid storage key");
		}
		return resolved;
	}

	async upload(key: string, data: Buffer, _contentType?: string): Promise<void> {
		const filePath = this.resolvePath(key);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, data);
	}

	async download(key: string): Promise<Buffer> {
		const filePath = this.resolvePath(key);
		return fs.readFile(filePath);
	}

	async delete(key: string): Promise<void> {
		const filePath = this.resolvePath(key);
		try {
			await fs.unlink(filePath);
		} catch (err: any) {
			if (err.code !== "ENOENT") throw err;
		}
	}

	async exists(key: string): Promise<boolean> {
		const filePath = this.resolvePath(key);
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	async listByPrefix(prefix: string): Promise<string[]> {
		const dirPath = this.resolvePath(prefix);
		const results: string[] = [];

		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch (err: any) {
				if (err.code === "ENOENT") return;
				throw err;
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (entry.isFile()) {
					// Return the key relative to baseDir
					results.push(path.relative(this.baseDir, fullPath));
				}
			}
		};

		await walk(dirPath);
		return results;
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		const dirPath = this.resolvePath(prefix);
		try {
			await fs.rm(dirPath, { recursive: true, force: true });
		} catch (err: any) {
			if (err.code !== "ENOENT") throw err;
		}
	}
}

export function createStorageService(): StorageService {
	const backend = process.env.STORAGE_BACKEND || "filesystem";
	if (backend === "filesystem") {
		return new LocalFsStorageService(process.env.STORAGE_BASE_DIR);
	}
	throw new Error(`Unknown STORAGE_BACKEND: ${backend}. Only "filesystem" is supported in Phase 3.`);
}
