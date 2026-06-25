import { describe, expect, it, vi } from 'vitest';
import { validateConfiguredModels } from '../src/model-catalog.js';

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
