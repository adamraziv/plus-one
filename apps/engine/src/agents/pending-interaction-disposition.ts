import {
  type InboundChannelMessageV1,
  type PendingWorkingMemoryMutation,
} from '@plus-one/contracts';

export function pendingInteractionDispositionPrompt(input: {
  message: InboundChannelMessageV1;
  pending?: PendingWorkingMemoryMutation;
  subject?: 'working_memory' | 'checked_mutation';
  changeSummary?: string;
  role?: 'primary' | 'checker';
}): string {
  const subject = input.subject ?? 'working_memory';
  const pending = input.pending;
  const changeSummary = input.changeSummary ?? (pending === undefined
    ? 'the pending checked mutation'
    : pending.mutation.operation === 'clear'
      ? 'clear all durable Working Memory'
      : pending.mutation.operation === 'delete'
        ? 'forget one existing durable Working Memory entry'
        : `${pending.mutation.operation} the durable Working Memory entry: ${pending.mutation.entry.summary}`);
  const role = input.role ?? 'primary';
  return [
    `${role === 'checker' ? 'Independently check' : 'Classify'} the meaning of the user message relative to ${subject === 'working_memory' ? 'the pending Working Memory confirmation' : 'the pending checked mutation'}.`,
    'Return {"kind":"resolve","decision":"approve"} only when the message clearly authorizes the exact pending change.',
    'Return {"kind":"resolve","decision":"reject"} only when the message clearly declines the exact pending change.',
    'Return {"kind":"new_intent"} for a standalone request that can be handled without resolving the pending change.',
    'Return {"kind":"ambiguous"} for uncertainty, mixed intent, or a message that refers to the pending change without a clear decision.',
    'Understand meaning across languages, spelling, punctuation, politeness, and short replies. Do not rely on a required word, phrase, or language.',
    'A mixed message that both appears to approve and changes the requested details is ambiguous.',
    'Semantic examples are guidance, not fixed matching rules: "Yes, go ahead and save it." means approve; "Ya, silakan simpan." means approve; "Tidak, jangan simpan." means reject; a standalone budget request means new_intent; "Yes, but make the preference detailed instead." means ambiguous.',
    `Pending proposed change: ${changeSummary}.`,
    `User message: ${input.message.body}`,
  ].join('\n');
}
