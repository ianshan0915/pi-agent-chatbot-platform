/**
 * S3-backed StorageService implementation.
 *
 * Uses AWS SDK v3. Requires S3_BUCKET_NAME env var.
 * AWS credentials are resolved via the default credential chain
 * (ECS task role in production, ~/.aws/credentials locally).
 */

import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { StorageService } from "./storage.js";

export class S3StorageService implements StorageService {
	private client: S3Client;
	private bucket: string;

	constructor(bucket: string, region?: string) {
		this.bucket = bucket;
		this.client = new S3Client({ region: region || process.env.AWS_REGION || "us-east-1" });
	}

	async upload(key: string, data: Buffer, contentType?: string): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
				ContentType: contentType || "application/octet-stream",
			}),
		);
	}

	async download(key: string): Promise<Buffer> {
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);
		const stream = response.Body;
		if (!stream) throw new Error(`Empty response for key: ${key}`);
		// Collect stream into buffer
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream as AsyncIterable<Uint8Array>) {
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);
			return true;
		} catch (err: any) {
			if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
				return false;
			}
			throw err;
		}
	}

	async listByPrefix(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let continuationToken: string | undefined;

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);
			for (const obj of response.Contents || []) {
				if (obj.Key) keys.push(obj.Key);
			}
			continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
		} while (continuationToken);

		return keys;
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		const keys = await this.listByPrefix(prefix);
		if (keys.length === 0) return;

		// DeleteObjects accepts max 1000 keys per request
		for (let i = 0; i < keys.length; i += 1000) {
			const batch = keys.slice(i, i + 1000);
			await this.client.send(
				new DeleteObjectsCommand({
					Bucket: this.bucket,
					Delete: {
						Objects: batch.map((Key) => ({ Key })),
						Quiet: true,
					},
				}),
			);
		}
	}
}
