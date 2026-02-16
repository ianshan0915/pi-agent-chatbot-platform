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
}

export function createStorageService(): StorageService {
	const backend = process.env.STORAGE_BACKEND || "filesystem";
	if (backend === "filesystem") {
		return new LocalFsStorageService(process.env.STORAGE_BASE_DIR);
	}
	throw new Error(`Unknown STORAGE_BACKEND: ${backend}. Only "filesystem" is supported in Phase 3.`);
}
