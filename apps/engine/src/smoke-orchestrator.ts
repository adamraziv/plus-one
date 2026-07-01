import { InboundChannelMessageSchemaV1, type InboundChannelMessageV1 } from '@plus-one/contracts';
import { bootstrap } from './bootstrap.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import { createOrchestratorSessionMemory } from './memory/orchestrator-session-memory.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const questions = process.argv.slice(2);
if (questions.length === 0) {
  questions.push(
    'What can you help our household with in one sentence?',
    'Can you execute a stock trade for me?',
  );
}

const runtime = await bootstrap();
const sessionMemory = createOrchestratorSessionMemory({
  connectionString: runtime.config.database.poolUrls.memory,
  model: runtime.config.models.orchestrator,
});
try {
  const orchestrator = new OrchestratorAgent({
    model: runtime.config.models.orchestrator,
    teams: runtime.agentSystem.teams,
    sessionMemory,
    teamRuntime: {
      runTeamLead: async () => {
        throw new Error('Smoke questions should not require team delegation.');
      },
    },
  });

  for (const [index, question] of questions.entries()) {
    const response = await orchestrator.run({ message: message(question, index + 1) });
    console.log(JSON.stringify({
      question,
      policyBoundary: response.policyBoundary,
      body: response.body,
      citations: response.citations.map((citation) => citation.label),
    }, null, 2));
  }
} finally {
  await sessionMemory.close();
  await runtime.close();
}

process.exit(0);

function message(body: string, ordinal: number): InboundChannelMessageV1 {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: `smoke-${Date.now()}-${ordinal}`,
    receivedAt: new Date().toISOString(),
    speaker: { principalRef: 'telegram:user:smoke', displayName: 'Smoke Test' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'smoke-chat' } },
  });
}
