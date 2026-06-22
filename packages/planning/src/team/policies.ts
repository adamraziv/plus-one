import {
  RuntimePolicySchemaV1,
  type RuntimePolicyV1,
} from '@plus-one/contracts';

export function createPlanningRuntimePolicies(models: {
  leadModel: string;
  makerModel: string;
  checkerModel: string;
}): RuntimePolicyV1[] {
  const policy = (policyName: string, primaryModel: string, maxAttempts: number): RuntimePolicyV1 =>
    RuntimePolicySchemaV1.parse({
      identity: { policyName, policyVersion: 1 },
      requiredCapabilities: ['structured_output'],
      primaryModel,
      fallbackModels: [],
      maxModelSteps: 4,
      maxToolConcurrency: 1,
      maxAttempts,
      maxModelRequestRetries: 1,
      maxProcessorRetries: 0,
      maxSandboxReproductions: 0,
      callDeadlineMs: 20_000,
      teamDeadlineMs: 60_000,
      endToEndDeadlineMs: 90_000,
      maxOutputBytes: 128_000,
    });
  return [
    policy('planning-lead', models.leadModel, 1),
    policy('planning-maker', models.makerModel, 2),
    policy('planning-checker', models.checkerModel, 2),
  ];
}
