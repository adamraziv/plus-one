// packages/accounting/src/posting/corrections.ts
import {
  PostingIdSchema, ReverseAndReplaceInputSchemaV1, type PostJournalInputV1,
  type ReverseAndReplaceInputV1,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { assertSerializableTransaction } from '../transactions.js';
import type { JournalPostingService } from './journal-posting-service.js';

type ReversiblePosting = Omit<PostJournalInputV1['postings'][number], 'postingId'>;

export function buildExactReversalPostings(
  postings: readonly ReversiblePosting[],
  nextPostingId: (index: number) => string,
): PostJournalInputV1['postings'] {
  return postings.map((posting, index) => ({
    ...posting,
    postingId: PostingIdSchema.parse(nextPostingId(index)),
    direction: posting.direction === 'debit' ? 'credit' : 'debit',
    tagIds: [...posting.tagIds],
  }));
}

export class CorrectionService {
  constructor(private readonly posting: Pick<JournalPostingService, 'postInTransaction'>) {}

  async reverseAndReplaceInTransaction(client: PoolClient, candidate: ReverseAndReplaceInputV1) {
    const input = ReverseAndReplaceInputSchemaV1.parse(candidate);
    await assertSerializableTransaction(client);
    const original = await client.query<{ journal_id: string }>(
      `SELECT journal_id FROM accounting.journals
       WHERE household_id = (
         SELECT id FROM operations.households WHERE household_id = $1
       ) AND journal_id = $2`,
      [input.reversal.householdId, input.originalJournalId],
    );
    if (original.rows[0] === undefined) throw new Error('Original journal was not found');
    const reversal = await this.posting.postInTransaction(client, input.reversal);
    const replacement = await this.posting.postInTransaction(client, input.replacement);
    return { originalJournalId: input.originalJournalId, reversal, replacement };
  }
}
