import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createSealer, readSealKey } from '../src/seal.js';

describe('sealing the keys users bring', () => {
	const sealer = createSealer(randomBytes(32));
	const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

	it('opens what it sealed, for the same user', () => {
		const sealed = sealer.seal(KEY, 7);
		assert.ok(!sealed.includes(KEY));
		assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
		assert.equal(sealer.unseal(sealed, 7), KEY);
	});

	it('seals the same key differently each time', () => {
		assert.notEqual(sealer.seal(KEY, 7), sealer.seal(KEY, 7));
	});

	it('won’t open a key sealed for another user', () => {
		assert.equal(sealer.unseal(sealer.seal(KEY, 7), 8), null);
	});

	it('won’t open under another seal key', () => {
		assert.equal(createSealer(randomBytes(32)).unseal(sealer.seal(KEY, 7), 7), null);
	});

	it('won’t open anything tampered with', () => {
		const [v, iv, tag, enc] = sealer.seal(KEY, 7).split('.');
		const flip = (s) => {
			const b = Buffer.from(s, 'base64url');
			b[0] ^= 1;
			return b.toString('base64url');
		};
		for (const bad of [
			[v, iv, tag, flip(enc)],
			[v, iv, flip(tag), enc],
			[v, flip(iv), tag, enc],
			['v2', iv, tag, enc],
			[v, iv, tag]
		])
			assert.equal(sealer.unseal(bad.join('.'), 7), null);
		assert.equal(sealer.unseal('', 7), null);
		assert.equal(sealer.unseal(null, 7), null);
	});

	it('takes its key as 64 hex characters or base64 of 32 bytes, and nothing weaker', () => {
		const hex = randomBytes(32).toString('hex');
		assert.equal(readSealKey(hex).toString('hex'), hex);
		const b = randomBytes(32);
		assert.ok(readSealKey(b.toString('base64')).equals(b));
		for (const bad of ['', 'short', randomBytes(16).toString('hex'), undefined])
			assert.throws(() => readSealKey(bad), /PRREVIEW_SEAL_KEY/);
		assert.throws(() => createSealer(randomBytes(16)), /32 bytes/);
	});
});
