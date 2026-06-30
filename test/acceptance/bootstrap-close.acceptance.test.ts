import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const script = `
  import { bootstrap } from "./apps/engine/src/bootstrap.ts";
  import { InboundChannelMessageSchemaV1 } from "./packages/contracts/src/index.ts";
  import { runOrchestratorLoop } from "./apps/engine/src/workflows/orchestrator-loop.ts";

  const message = InboundChannelMessageSchemaV1.parse({
    schemaName: "inbound-channel-message",
    schemaVersion: 1,
    conversationId: "conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K",
    householdId: "hh_01JNZQ4A9B8C7D6E5F4G3H2J1K",
    channel: "telegram",
    externalMessageId: "close-check-1",
    receivedAt: "2026-06-30T00:00:00.000Z",
    speaker: { principalRef: "telegram:user:close", displayName: "Close Check" },
    body: "Remember that soda is Snacks.",
    attachments: [],
    metadata: { destination: { chatId: "close-chat" } }
  });

  const runtime = await bootstrap();
  const workflow = runtime.mastra.getWorkflow("orchestrator-loop");
  await runOrchestratorLoop({ workflow, message });
  await runtime.close();
`;

describe('bootstrap close acceptance', () => {
  it('exits after closing runtime resources', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    const exit = Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`bootstrap() process did not exit.\n${output}`)), 90_000);
      }),
    ]);

    const [code] = await exit as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
  }, 120_000);
});
