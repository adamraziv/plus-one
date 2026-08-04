import { describe, expect, it } from 'vitest';
import {
  runSerialFreeModelSweep,
  workingMemoryAcceptanceArgs,
  workingMemoryModelEnvironment,
} from '../../../scripts/verify-working-memory-free-models.js';

describe('Working Memory free-model sweep', () => {
  it('rejects an empty free-model set', async () => {
    await expect(runSerialFreeModelSweep({ modelIds: [] })).rejects.toThrow(/no free models/i);
  });

  it('executes model checks strictly serially and records safe outcomes', async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const results = await runSerialFreeModelSweep({
      modelIds: ['opencode/alpha-free', 'opencode/beta-free'],
      runModel: async (modelId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`start:${modelId}`);
        await Promise.resolve();
        events.push(`end:${modelId}`);
        active -= 1;
        return modelId.endsWith('alpha-free') ? { ok: true } : { ok: false, failureCode: 'exit_1' };
      },
    });

    expect(maximumActive).toBe(1);
    expect(events).toEqual([
      'start:opencode/alpha-free',
      'end:opencode/alpha-free',
      'start:opencode/beta-free',
      'end:opencode/beta-free',
    ]);
    expect(results).toEqual([
      { modelId: 'opencode/alpha-free', ok: true, durationMs: expect.any(Number) },
      { modelId: 'opencode/beta-free', ok: false, durationMs: expect.any(Number), failureCode: 'exit_1' },
    ]);
  });

  it('uses argument arrays for the focused acceptance command', () => {
    expect(workingMemoryAcceptanceArgs()).toEqual([
      'exec',
      'vitest',
      '--workspace',
      'vitest.workspace.ts',
      'run',
      '--project',
      'acceptance',
      'test/acceptance/working-memory-live.acceptance.test.ts',
      '--no-file-parallelism',
      '-t',
      'working-memory-model-compatibility:',
    ]);
  });

  it('isolates every live agent role to the model under test', () => {
    expect(workingMemoryModelEnvironment('opencode/alpha-free')).toEqual({
      ORCHESTRATOR_MODEL: 'opencode/alpha-free',
      LEAD_MODEL: 'opencode/alpha-free',
      MAKER_MODEL: 'opencode/alpha-free',
      CHECKER_MODEL: 'opencode/alpha-free',
      RESEARCH_MODEL: 'opencode/alpha-free',
    });
  });
});
