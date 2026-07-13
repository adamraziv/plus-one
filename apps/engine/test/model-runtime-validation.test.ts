import { describe, expect, it, vi } from 'vitest';
import { validateRuntimeModels } from '../src/model-runtime-validation.js';

const orchestratorModel = {
  id: 'openai/gpt-5',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
};

const input = {
  endpoint: orchestratorModel.endpoint,
  apiKey: orchestratorModel.apiKey,
  modelIds: [orchestratorModel.id, 'openai/gpt-5-mini'],
  orchestratorModel,
};

describe('runtime model validation', () => {
  it('validates catalog availability before the orchestrator model contract', async () => {
    const order: string[] = [];
    const validateCatalog = vi.fn(async () => {
      order.push('catalog');
    });
    const validateCapabilities = vi.fn(async () => {
      order.push('capabilities');
    });

    await expect(validateRuntimeModels(input, {
      validateCatalog,
      validateCapabilities,
    })).resolves.toBeUndefined();

    expect(order).toEqual(['catalog', 'capabilities']);
    expect(validateCatalog).toHaveBeenCalledWith({
      endpoint: input.endpoint,
      apiKey: input.apiKey,
      modelIds: input.modelIds,
    });
    expect(validateCapabilities).toHaveBeenCalledWith({
      model: orchestratorModel,
    });
  });

  it('does not probe capabilities when catalog validation fails', async () => {
    const catalogFailure = new Error('catalog unavailable');
    const validateCatalog = vi.fn(async () => {
      throw catalogFailure;
    });
    const validateCapabilities = vi.fn(async () => undefined);

    await expect(validateRuntimeModels(input, {
      validateCatalog,
      validateCapabilities,
    })).rejects.toBe(catalogFailure);

    expect(validateCapabilities).not.toHaveBeenCalled();
  });
});
