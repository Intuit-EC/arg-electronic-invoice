import { canonicalJson } from './canonical-payload.util';
import { calculateBackoffSeconds } from './retry-backoff.util';
import {
  assertPublicCallbackDestination,
  parseAndValidateCallbackUrl,
} from './callback-security.util';

describe('jobs utilities', () => {
  it('canonicalizes object keys recursively without changing array order', () => {
    const left = { b: 2, nested: { z: 1, a: 2 }, array: [{ y: 1, x: 2 }] };
    const right = { array: [{ x: 2, y: 1 }], nested: { a: 2, z: 1 }, b: 2 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('requires HTTPS callbacks in production', () => {
    expect(() =>
      parseAndValidateCallbackUrl('http://example.com/callback', true),
    ).toThrow('HTTPS');
  });

  it('rejects loopback callback destinations', async () => {
    const url = parseAndValidateCallbackUrl('https://127.0.0.1/callback', true);

    await expect(assertPublicCallbackDestination(url)).rejects.toThrow(
      'no pública',
    );
  });

  it('keeps exponential backoff inside the jitter range and cap', () => {
    const delay = calculateBackoffSeconds(4, 30, 900);
    expect(delay).toBeGreaterThanOrEqual(192);
    expect(delay).toBeLessThanOrEqual(288);

    const capped = calculateBackoffSeconds(20, 30, 900);
    expect(capped).toBeGreaterThanOrEqual(720);
    expect(capped).toBeLessThanOrEqual(900);
  });
});
