/**
 * Filename sanitization and Content-Disposition header generation.
 *
 * Strips path separators, null bytes, control chars, and quotes from filenames.
 * Generates RFC 5987 Content-Disposition headers with ASCII fallback + UTF-8 encoding.
 */

/** Strip path separators, null bytes, control chars, and quotes from a filename. */
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[\\/]/g, "_") // path separators
		.replace(/\0/g, "") // null bytes
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, "") // control chars
		.replace(/["']/g, "") // quotes
		.trim() || "download";
}

/**
 * Build a safe Content-Disposition header value.
 *
 * Returns `attachment; filename="ascii-safe"; filename*=UTF-8''percent-encoded`
 * per RFC 6266 / RFC 5987.
 */
export function contentDisposition(rawFilename: string): string {
	const safe = sanitizeFilename(rawFilename);

	// ASCII-only fallback: replace any non-ASCII with underscores
	const asciiFallback = safe.replace(/[^\x20-\x7e]/g, "_");

	// UTF-8 percent-encoded version
	const utf8Encoded = encodeURIComponent(safe).replace(/['()]/g, (c) =>
		`%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
