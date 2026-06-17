import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { JsonValueSchema } from '@plus-one/contracts';
export function canonicalizeJson(value) {
    const parsed = JsonValueSchema.safeParse(value);
    if (!parsed.success) {
        throw new TypeError('Expected a JSON value', { cause: parsed.error });
    }
    const canonical = canonicalize(parsed.data);
    if (canonical === undefined) {
        throw new TypeError('Expected a JSON value that can be canonicalized');
    }
    return canonical;
}
export function hashArtifact(value) {
    return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}
