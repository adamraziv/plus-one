import { describe, expect, it, vi } from 'vitest';
import { validateRuntimeModels } from '../src/model-runtime-validation.js';

const input = {
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
  modelIds: ['openai/gpt-5', 'openai/gpt-5-mini'],
};

describe('runtime model validation', () => {
  it('validates configured model ids without a behavioral model generation probe', async () => {
    const validateCatalog = vi.fn(async () => undefined);

    await expect(validateRuntimeModels(input, { validateCatalog })).resolves.toBeUndefined();

    expect(validateCatalog).toHaveBeenCalledOnce();
    expect(validateCatalog).toHaveBeenCalledWith(input);
  });

  it('preserves catalog validation failures as startup blockers', async () => {
    const catalogFailure = new Error('catalog unavailable');
    const validateCatalog = vi.fn(async () => {
      throw catalogFailure;
    });

    await expect(validateRuntimeModels(input, { validateCatalog })).rejects.toBe(catalogFailure);
  });
});
