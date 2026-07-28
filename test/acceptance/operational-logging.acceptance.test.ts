import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DeliveryRecordSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import {
  ChannelGateway,
  configureLogging,
  getLogger,
  parseLogEnvelope,
  type LogEnvelopeV1,
} from '@plus-one/runtime';
import { describe, expect, it, vi } from 'vitest';
import { startGatewayDaemon } from '../../apps/engine/src/daemon-runtime.js';
import { runLogsCli } from '../../apps/engine/src/logs-cli.js';

const deliveredBody = 'private delivered message body';
const failedBody = 'private failed message body';
const responseBody = 'private model response body';

const deliveredMessage = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram:42:100',
  receivedAt: '2026-07-28T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:42' },
  body: deliveredBody,
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-private' } },
});

const failedMessage = InboundChannelMessageSchemaV1.parse({
  ...deliveredMessage,
  externalMessageId: 'telegram:42:101',
  receivedAt: '2026-07-28T00:01:00.000Z',
  body: failedBody,
});

const response = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-operational-logging',
  householdId: deliveredMessage.householdId,
  conversationId: deliveredMessage.conversationId,
  body: responseBody,
  policyBoundary: 'personalized_finance',
  citations: [{ label: 'safe citation' }],
  assumptions: [],
  freshness: ['current invocation only'],
  disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
  unsupportedCapabilities: [],
  recommendationActions: [],
  delivery: {
    channel: 'telegram',
    destination: { chatId: 'telegram-chat-private' },
    format: 'plain_text',
  },
  responseHash: 'a'.repeat(64),
  createdAt: '2026-07-28T00:00:01.000Z',
});

const delivery = DeliveryRecordSchemaV1.parse({
  schemaName: 'delivery-record',
  schemaVersion: 1,
  deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: deliveredMessage.householdId,
  conversationId: deliveredMessage.conversationId,
  channel: 'telegram',
  idempotencyKey: 'operational-logging-acceptance',
  responseHash: response.responseHash,
  status: 'delivered',
  destination: { chatId: 'telegram-chat-private' },
  platformMessageId: '200',
  attemptCount: 1,
  createdAt: '2026-07-28T00:00:01.000Z',
  updatedAt: '2026-07-28T00:00:01.000Z',
});

function outputBuffer(): {
  output: { write(text: string): void };
  text(): string;
} {
  const chunks: string[] = [];
  return {
    output: { write: (text) => chunks.push(text) },
    text: () => chunks.join(''),
  };
}

async function physicalRecords(path: string): Promise<LogEnvelopeV1[]> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const record = parseLogEnvelope(line);
    expect(record).toBeDefined();
    expect(record).toMatchObject({ schemaVersion: 1 });
    return record!;
  });
}

describe('operational logging', () => {
  it('persists delivered and failed gateway turns as V1 and reads safe human and JSON output', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-logging-acceptance-'));
    const logging = configureLogging({ homeDirectory, mode: 'gateway' });
    const orchestrator = {
      run: vi.fn()
        .mockResolvedValueOnce(response)
        .mockRejectedValueOnce(new Error('private raw provider error')),
    };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator,
      delivery: {
        deliver: vi.fn(async () => ({
          status: 'delivered' as const,
          sent: true,
          delivery,
        })),
      },
      heartbeat: { typingEveryMs: 60_000 },
    });

    await expect(gateway.handleInbound(deliveredMessage)).resolves.toMatchObject({
      status: 'delivered',
    });
    await expect(gateway.handleInbound(failedMessage)).resolves.toEqual({
      status: 'failed',
      error: 'orchestrator_failed',
      sent: false,
    });
    await gateway.shutdown();
    await logging.close();

    const logDirectory = join(homeDirectory, 'logs');
    const agentRecords = await physicalRecords(join(logDirectory, 'agent.log'));
    const errorRecords = await physicalRecords(join(logDirectory, 'errors.log'));
    const gatewayRecords = await physicalRecords(join(logDirectory, 'gateway.log'));
    expect(agentRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: 'gateway.turn.completed', severityText: 'INFO' }),
      expect.objectContaining({ eventName: 'gateway.turn.failed', severityText: 'ERROR' }),
    ]));
    expect(errorRecords.map(({ eventName }) => eventName)).toContain('gateway.turn.failed');
    expect(gatewayRecords.map(({ eventName }) => eventName)).toEqual(
      agentRecords.map(({ eventName }) => eventName),
    );

    const human = outputBuffer();
    await expect(runLogsCli(['gateway', '--lines', '100'], {
      environment: { PLUS_ONE_HOME: homeDirectory },
      stdout: human.output,
      stderr: outputBuffer().output,
    })).resolves.toBe(0);
    expect(human.text()).toContain('gateway.turn.completed');
    expect(human.text()).toContain('gateway.turn.failed');

    const json = outputBuffer();
    await expect(runLogsCli(['gateway', '--lines', '100', '--json'], {
      environment: { PLUS_ONE_HOME: homeDirectory },
      stdout: json.output,
      stderr: outputBuffer().output,
    })).resolves.toBe(0);
    const cliRecords = json.text().trim().split('\n').map((line) => parseLogEnvelope(line));
    expect(cliRecords.every((record) => record?.schemaVersion === 1)).toBe(true);
    expect(cliRecords.map((record) => record?.eventName)).toEqual(
      expect.arrayContaining(['gateway.turn.completed', 'gateway.turn.failed']),
    );

    const serializedEvidence = JSON.stringify({
      agentRecords,
      errorRecords,
      gatewayRecords,
      human: human.text(),
      json: json.text(),
    });
    expect(serializedEvidence).not.toMatch(
      /private delivered message body|private failed message body|private model response body|private raw provider error|telegram-chat-private/,
    );
  });

  it('mirrors canonical gateway records to stdout only when enabled', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-logging-stdout-'));
    const stdoutLines: string[] = [];
    const logging = configureLogging({
      homeDirectory,
      mode: 'gateway',
      environment: {
        NODE_ENV: 'test',
        PLUS_ONE_LOG_STDOUT: 'true',
      },
      stdout: { write: (line) => stdoutLines.push(line) },
    });
    getLogger('engine.gateway').info('runtime.started', {
      fields: { mode: 'gateway' },
    });
    await logging.close();

    expect(stdoutLines.map((line) => parseLogEnvelope(line.trim()))).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        eventName: 'runtime.started',
      }),
    ]);
  });

  it('separates daemon console output and merges launcher events into the gateway CLI stream', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-logging-daemon-'));
    const environment = {
      PLUS_ONE_HOME: homeDirectory,
      ENGINE_HOST: '127.0.0.1',
      ENGINE_PORT: '4111',
    };
    const gatewayLogging = configureLogging({
      homeDirectory,
      mode: 'gateway',
      environment,
    });
    getLogger('engine.gateway').info('runtime.started', {
      fields: { mode: 'gateway' },
    });
    await gatewayLogging.close();
    const gatewayPath = join(homeDirectory, 'logs', 'gateway.log');
    const gatewayBefore = await readFile(gatewayPath, 'utf8');

    class FakeChild extends EventEmitter {
      readonly pid = 4321;
      readonly unref = vi.fn();
    }
    const child = new FakeChild();
    let spawnedLogFilePath: string | undefined;
    const spawnProcess = vi.fn((input: {
      launcherPath: string;
      installationRoot: string;
      logFilePath: string;
    }) => {
      spawnedLogFilePath = input.logFilePath;
      return child;
    });
    await expect(startGatewayDaemon({
      environment,
      state: {
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      spawnProcess,
      fetch: async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 }),
      isProcessAlive: () => true,
      sleep: async () => undefined,
      stdout: outputBuffer().output,
      stderr: outputBuffer().output,
    })).resolves.toBe(0);

    if (spawnedLogFilePath === undefined) throw new Error('Expected daemon spawn');
    expect(basename(spawnedLogFilePath)).toBe('launcher-console.log');
    expect(spawnedLogFilePath).not.toBe(gatewayPath);
    expect(await readFile(gatewayPath, 'utf8')).toBe(gatewayBefore);
    const launcherRecords = await physicalRecords(join(homeDirectory, 'logs', 'launcher.log'));
    expect(launcherRecords.map(({ eventName }) => eventName)).toEqual([
      'launcher.starting',
      'launcher.started',
    ]);

    const output = outputBuffer();
    await expect(runLogsCli(['gateway', '--json', '--lines', '100'], {
      environment,
      stdout: output.output,
      stderr: outputBuffer().output,
    })).resolves.toBe(0);
    const eventNames = output.text()
      .trim()
      .split('\n')
      .map((line) => parseLogEnvelope(line)?.eventName);
    expect(eventNames).toEqual(expect.arrayContaining([
      'runtime.started',
      'launcher.starting',
      'launcher.started',
    ]));
  });
});
