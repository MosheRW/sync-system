import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_SEGMENT_LENGTH,
  TOKEN_HEADER_SEGMENT,
  hmacSha256,
  signHs256,
  verifyHs256,
} from '../src/tokens/jwt.js';
import { b64url, forge, headerSegment } from './helpers/tokens.js';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const PAYLOAD = '{"v":1,"x":"y"}';

describe('hmacSha256', () => {
  it('matches the RFC 7515 appendix A.1 test vector', () => {
    const key = Buffer.from(
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow',
      'base64url',
    );
    const signingInput =
      'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9' +
      '.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';
    expect(hmacSha256(signingInput, key).toString('base64url')).toBe(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
  });
});

describe('signHs256 / verifyHs256', () => {
  it('emits the fixed header and a 43-character signature', () => {
    const token = signHs256(PAYLOAD, KEY);
    const [header, payload, signature] = token.split('.');
    expect(header).toBe(TOKEN_HEADER_SEGMENT);
    expect(Buffer.from(header!, 'base64url').toString()).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(Buffer.from(payload!, 'base64url').toString()).toBe(PAYLOAD);
    expect(signature).toHaveLength(SIGNATURE_SEGMENT_LENGTH);
  });

  it('verifies with the matching key and reports which one', () => {
    const token = signHs256(PAYLOAD, OTHER);
    expect(verifyHs256(token, [KEY, OTHER])).toEqual({
      payloadSegment: b64url(PAYLOAD),
      keyIndex: 1,
    });
    expect(verifyHs256(signHs256(PAYLOAD, KEY), [KEY, OTHER])?.keyIndex).toBe(0);
    expect(verifyHs256(token, [KEY])).toBeUndefined();
  });

  const forgedHeaders: Array<[string, string]> = [
    ['alg none', headerSegment({ alg: 'none', typ: 'JWT' })],
    ['HS512', headerSegment({ alg: 'HS512', typ: 'JWT' })],
    ['RS256', headerSegment({ alg: 'RS256', typ: 'JWT' })],
    ['an extra kid', headerSegment({ alg: 'HS256', typ: 'JWT', kid: 'k1' })],
    ['reordered keys', headerSegment({ typ: 'JWT', alg: 'HS256' })],
    ['no typ', headerSegment({ alg: 'HS256' })],
  ];

  for (const [label, header] of forgedHeaders) {
    it(`rejects a header with ${label}, even when the HMAC is right`, () => {
      expect(verifyHs256(forge(PAYLOAD, KEY, { header }), [KEY])).toBeUndefined();
    });
  }

  it('rejects alg none with an empty signature', () => {
    const header = headerSegment({ alg: 'none', typ: 'JWT' });
    expect(verifyHs256(`${header}.${b64url(PAYLOAD)}.`, [KEY])).toBeUndefined();
  });

  it('rejects an HS512 signature', () => {
    expect(verifyHs256(forge(PAYLOAD, KEY, { algorithm: 'sha512' }), [KEY])).toBeUndefined();
  });

  it('rejects a bad, short or non-canonical signature (L1)', () => {
    const token = signHs256(PAYLOAD, KEY);
    const [h, p, s] = token.split('.') as [string, string, string];
    const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(verifyHs256(`${h}.${p}.${flipped}`, [KEY])).toBeUndefined();
    const short = Buffer.from(s, 'base64url').subarray(0, 31).toString('base64url');
    expect(verifyHs256(`${h}.${p}.${short}`, [KEY])).toBeUndefined();
    // The 43rd character carries 4 data bits and 2 unused bits: a sibling
    // character that differs only in the unused bits decodes to the same
    // bytes, but is not the canonical encoding.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(s.at(-1)!);
    const sibling = alphabet[last ^ 1]!;
    const malleable = `${h}.${p}.${s.slice(0, -1)}${sibling}`;
    expect(
      Buffer.from(malleable.split('.')[2]!, 'base64url').equals(Buffer.from(s, 'base64url')),
    ).toBe(true);
    expect(verifyHs256(malleable, [KEY])).toBeUndefined();
  });

  it('rejects bad shapes before any HMAC', () => {
    const token = signHs256(PAYLOAD, KEY);
    const [h, p, s] = token.split('.') as [string, string, string];
    for (const bad of [
      `${h}.${p}`,
      `${h}.${p}.${s}.${s}`,
      `${h}..${s}`,
      `${h}.${p}=.${s}`,
      `${h}.${p}+.${s}`,
      ` ${token}`,
      `${h}.${'a'.repeat(2048)}.${s}`,
      '',
      42,
      null,
      undefined,
    ]) {
      expect(verifyHs256(bad, [KEY])).toBeUndefined();
    }
  });
});
