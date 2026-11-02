/**
 * Sealing for the keys users bring: AES-256-GCM under PRREVIEW_SEAL_KEY (its
 * own secret, so rotating the session secret doesn't lose anyone's key), with
 * the owner's user id as additional data, so a sealed key copied onto another
 * user's row doesn't open. A copy of the database alone reveals no key.
 *
 *   v1.<iv>.<tag>.<ciphertext>   (base64url parts)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');

/** The 32-byte key from its configured form: 64 hex characters, or base64 of 32 bytes. */
export function readSealKey(text) {
	const s = String(text ?? '').trim();
	const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
	if (key.length !== 32)
		throw new Error(
			'PRREVIEW_SEAL_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32).'
		);
	return key;
}

/** @param {Buffer} key */
export function createSealer(key) {
	if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A seal key is 32 bytes.');
	return {
		/** @param {string} text @param {string | number} owner */
		seal(text, owner) {
			const iv = randomBytes(12);
			const c = createCipheriv('aes-256-gcm', key, iv);
			c.setAAD(Buffer.from(`user:${owner}`));
			const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
			return `v1.${b64(iv)}.${b64(c.getAuthTag())}.${b64(enc)}`;
		},
		/** The text, or null when it was tampered with, sealed for someone else, or under another key. */
		unseal(sealed, owner) {
			const parts = String(sealed ?? '').split('.');
			if (parts.length !== 4 || parts[0] !== 'v1') return null;
			try {
				const [iv, tag, enc] = parts.slice(1).map((x) => Buffer.from(x, 'base64url'));
				if (iv.length !== 12 || tag.length !== 16) return null;
				const d = createDecipheriv('aes-256-gcm', key, iv);
				d.setAAD(Buffer.from(`user:${owner}`));
				d.setAuthTag(tag);
				return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
			} catch {
				return null;
			}
		}
	};
}
