/**
 * Envelope encryption service for provider API keys.
 *
 * Uses AES-256-GCM with a two-layer key scheme:
 * - Root key (from ENCRYPTION_ROOT_KEY env var) wraps per-record DEKs
 * - Each record gets a random DEK that encrypts the actual data
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const DEK_LENGTH = 32; // 256-bit DEK
const AUTH_TAG_LENGTH = 16;

export interface EncryptedEnvelope {
	encryptedDek: Buffer; // IV (12) + ciphertext (32) + authTag (16) = 60 bytes
	encryptedData: Buffer; // ciphertext + authTag (16)
	iv: Buffer; // 12-byte IV for data encryption
	keyVersion: number;
}

export interface CryptoService {
	encrypt(plaintext: string): EncryptedEnvelope;
	decrypt(envelope: EncryptedEnvelope): string;
}

/**
 * Create a CryptoService instance.
 * Reads ENCRYPTION_ROOT_KEY from environment (64 hex chars = 32 bytes).
 */
export function createCryptoService(): CryptoService {
	const rootKeyHex = process.env.ENCRYPTION_ROOT_KEY;
	if (!rootKeyHex || rootKeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(rootKeyHex)) {
		throw new Error(
			"ENCRYPTION_ROOT_KEY must be set to a 64-character hex string (32 bytes)",
		);
	}
	const rootKey = Buffer.from(rootKeyHex, "hex");

	function wrapDek(dek: Buffer): Buffer {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, rootKey, iv);
		const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
		const authTag = cipher.getAuthTag();
		// Format: IV (12) + encrypted DEK (32) + authTag (16)
		return Buffer.concat([iv, encrypted, authTag]);
	}

	function unwrapDek(wrappedDek: Buffer): Buffer {
		const iv = wrappedDek.subarray(0, IV_LENGTH);
		const encrypted = wrappedDek.subarray(IV_LENGTH, IV_LENGTH + DEK_LENGTH);
		const authTag = wrappedDek.subarray(IV_LENGTH + DEK_LENGTH, IV_LENGTH + DEK_LENGTH + AUTH_TAG_LENGTH);

		const decipher = createDecipheriv(ALGORITHM, rootKey, iv);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(encrypted), decipher.final()]);
	}

	return {
		encrypt(plaintext: string): EncryptedEnvelope {
			// Generate random DEK and IV for data encryption
			const dek = randomBytes(DEK_LENGTH);
			const dataIv = randomBytes(IV_LENGTH);

			// Encrypt data with DEK
			const cipher = createCipheriv(ALGORITHM, dek, dataIv);
			const encryptedData = Buffer.concat([
				cipher.update(plaintext, "utf8"),
				cipher.final(),
				cipher.getAuthTag(),
			]);

			// Wrap DEK with root key
			const encryptedDek = wrapDek(dek);

			return {
				encryptedDek,
				encryptedData,
				iv: dataIv,
				keyVersion: 1,
			};
		},

		decrypt(envelope: EncryptedEnvelope): string {
			// Unwrap DEK
			const dek = unwrapDek(envelope.encryptedDek);

			// Decrypt data
			const authTagStart = envelope.encryptedData.length - AUTH_TAG_LENGTH;
			const encrypted = envelope.encryptedData.subarray(0, authTagStart);
			const authTag = envelope.encryptedData.subarray(authTagStart);

			const decipher = createDecipheriv(ALGORITHM, dek, envelope.iv);
			decipher.setAuthTag(authTag);
			return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
		},
	};
}
