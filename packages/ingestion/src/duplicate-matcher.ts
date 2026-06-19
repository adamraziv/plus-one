import { createHash } from 'node:crypto';
import type { JsonValue } from '@plus-one/contracts';
import { canonicalizeJson } from '@plus-one/runtime';

const digest = (parts: JsonValue[]) => createHash('sha256').update(canonicalizeJson(parts), 'utf8').digest('hex');

export class DuplicateMatcher {
  exactFingerprint(input: {
    householdId: string;
    sourceAccountId: string;
    sourceSystem: string;
    externalTransactionId?: string;
    sourceDocumentHash: string;
    sourceRowIdentity: string;
    rawPayload: JsonValue;
  }): { kind: 'stable_external_id' | 'source_row_fallback'; hash: string } {
    return input.externalTransactionId === undefined
      ? {
        kind: 'source_row_fallback',
        hash: digest([
          input.householdId,
          input.sourceAccountId,
          input.sourceSystem,
          input.sourceDocumentHash,
          input.sourceRowIdentity,
          input.rawPayload,
        ]),
      }
      : {
        kind: 'stable_external_id',
        hash: digest([input.householdId, input.sourceAccountId, input.sourceSystem, input.externalTransactionId]),
      };
  }

  scoreProbable(
    row: { amount: string; occurredOn: string; description: string; counterparty?: string },
    candidate: { amount: string; occurredOn: string; description: string; counterparty?: string },
  ): { classification: 'probable_duplicate' | 'distinct'; score: number; evidence: string[] } {
    const evidence: string[] = [];
    let score = 0;
    if (row.amount === candidate.amount) {
      evidence.push('same_amount');
      score += 0.4;
    }
    if (row.occurredOn === candidate.occurredOn) {
      evidence.push('same_date');
      score += 0.25;
    }
    if (row.description.trim().toLowerCase() === candidate.description.trim().toLowerCase()) {
      evidence.push('same_description');
      score += 0.2;
    }
    if (row.counterparty !== undefined && row.counterparty === candidate.counterparty) {
      evidence.push('same_counterparty');
      score += 0.15;
    }
    return {
      classification: score >= 0.7 ? 'probable_duplicate' : 'distinct',
      score: Number(score.toFixed(4)),
      evidence,
    };
  }
}
