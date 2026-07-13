import { validateConfiguredModels } from './model-catalog.js';

interface RuntimeModelValidationInput {
  endpoint: string;
  apiKey: string;
  modelIds: readonly string[];
}

interface RuntimeModelValidationDependencies {
  validateCatalog?: typeof validateConfiguredModels;
}

export async function validateRuntimeModels(
  input: RuntimeModelValidationInput,
  dependencies: RuntimeModelValidationDependencies = {},
): Promise<void> {
  await (dependencies.validateCatalog ?? validateConfiguredModels)({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    modelIds: input.modelIds,
  });
}
