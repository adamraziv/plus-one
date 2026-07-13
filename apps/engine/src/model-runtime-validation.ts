import type { EngineLlmModelConfig } from './config.js';
import { validateConfiguredModels } from './model-catalog.js';
import { validateOrchestratorModelCapabilities } from './orchestrator-model-capabilities.js';

interface RuntimeModelValidationInput {
  endpoint: string;
  apiKey: string;
  modelIds: readonly string[];
  orchestratorModel: EngineLlmModelConfig;
}

interface RuntimeModelValidationDependencies {
  validateCatalog?: typeof validateConfiguredModels;
  validateCapabilities?: typeof validateOrchestratorModelCapabilities;
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
  await (dependencies.validateCapabilities ?? validateOrchestratorModelCapabilities)({
    model: input.orchestratorModel,
  });
}
