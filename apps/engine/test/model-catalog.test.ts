import { describe, expect, it, vi } from 'vitest';
import { freeModelIds, modelCatalogUrl, validateConfiguredModels } from '../src/model-catalog.js';

describe('free model discovery', () => {
  it('returns sorted canonical free model ids from the catalog', () => {
    expect(freeModelIds({
      data: [
        { id: 'zeta-free', owned_by: 'opencode' },
        { id: 'paid-model', owned_by: 'opencode' },
        { id: 'alpha-free', owned_by: 'opencode' },
        { id: 'already/vendor-free' },
      ],
    })).toEqual(['already/vendor-free', 'opencode/alpha-free', 'opencode/zeta-free']);
  });

  it('rejects an empty or malformed catalog instead of silently skipping the sweep', () => {
    expect(freeModelIds({ data: [] })).toEqual([]);
    expect(() => freeModelIds({ data: [{ owned_by: 'opencode' }] })).toThrow();
  });

  it('normalizes nested OpenAI-compatible endpoints to their models route', () => {
    expect(modelCatalogUrl('https://opencode.ai/zen/v1/chat/completions'))
      .toBe('https://opencode.ai/zen/v1/models');
    expect(modelCatalogUrl('https://opencode.ai/zen/v1/')).toBe('https://opencode.ai/zen/v1/models');
  });
});

describe('model catalog validation', () => {
  it('accepts configured provider/model ids found at endpoint /models', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
    }), { status: 200 }));

    await expect(validateConfiguredModels({
      endpoint: 'https://api.deepseek.com',
      apiKey: 'test-key',
      modelIds: ['deepseek/deepseek-v4-flash'],
      fetch,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }));
  });

  it('resolves /models relative to nested API bases instead of the domain root', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'deepseek-v4-flash-free', owned_by: 'opencode' }],
    }), { status: 200 }));

    await expect(validateConfiguredModels({
      endpoint: 'https://opencode.ai/zen/v1',
      apiKey: 'test-key',
      modelIds: ['opencode/deepseek-v4-flash-free'],
      fetch,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith('https://opencode.ai/zen/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }));
  });

  it('rejects configured models missing from endpoint /models', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'deepseek/other-model' }],
    }), { status: 200 }));

    await expect(validateConfiguredModels({
      endpoint: 'https://api.deepseek.com/',
      apiKey: 'test-key',
      modelIds: ['deepseek/deepseek-v4-flash'],
      fetch,
    })).rejects.toMatchObject({ code: 'llm_model_not_available' });
  });

  it('fails startup when /models is unavailable', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 503 }));

    await expect(validateConfiguredModels({
      endpoint: 'https://api.deepseek.com',
      apiKey: 'test-key',
      modelIds: ['deepseek/deepseek-v4-flash'],
      fetch,
    })).rejects.toMatchObject({ code: 'llm_model_catalog_unavailable' });
  });
});
