import { describe, expect, it } from 'vitest';
import { canonicalizeJson, hashArtifact } from './canonical-json.js';
describe('canonical artifacts', () => {
    it('canonicalizes object keys independently of insertion order', () => {
        expect(canonicalizeJson({ b: 2, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":2}');
        expect(hashArtifact({ a: 1, b: 2 })).toBe(hashArtifact({ b: 2, a: 1 }));
    });
    it('rejects values outside the JSON contract', () => {
        expect(() => canonicalizeJson({ amount: 1n })).toThrow(/JSON value/);
        expect(() => canonicalizeJson({ invalid: Number.NaN })).toThrow(/JSON value/);
    });
});
