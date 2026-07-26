import { PlusOneError } from '@plus-one/contracts';
import { z } from 'zod';

const ModelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    owned_by: z.string().optional(),
  }).passthrough()),
}).passthrough();

export function freeModelIds(catalog: unknown): string[] {
  return ModelsResponseSchema.parse(catalog).data
    .filter(({ id }) => id.endsWith('-free'))
    .map(({ id, owned_by }) => id.includes('/') || owned_by === undefined ? id : `${owned_by}/${id}`)
    .sort();
}

export function modelCatalogUrl(endpoint: string): string {
  const base = endpoint.endsWith('/chat/completions')
    ? endpoint.slice(0, -'/chat/completions'.length)
    : endpoint;
  return new URL('models', base.endsWith('/') ? base : `${base}/`).toString();
}

export async function validateConfiguredModels(input: {
  endpoint: string;
  apiKey: string;
  modelIds: readonly string[];
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(modelCatalogUrl(input.endpoint), {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });

  if (!response.ok) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'llm_model_catalog_unavailable',
      message: 'Configured LLM endpoint did not return a usable /models response',
      retry: 'after_backoff',
      receiptLookupRequired: false,
      details: { endpoint: input.endpoint, status: response.status },
    });
  }

  const available = new Set(ModelsResponseSchema.parse(await response.json()).data.flatMap((model) => {
    const canonical = model.id.includes('/') || model.owned_by === undefined
      ? []
      : [`${model.owned_by}/${model.id}`];
    return [model.id, ...canonical];
  }));
  const missing = [...new Set(input.modelIds)].filter((modelId) => !available.has(modelId));
  if (missing.length === 0) return;

  throw new PlusOneError({
    category: 'validation_rejected',
    code: 'llm_model_not_available',
    message: 'Configured LLM model was not found in endpoint /models',
    retry: 'never',
    receiptLookupRequired: false,
    details: { endpoint: input.endpoint, missing: missing.join(',') },
  });
}
