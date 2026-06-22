import {
  RuntimePolicySchemaV1,
  type RuntimePolicyV1,
} from '@plus-one/contracts';

export function createReportingRuntimePolicies(models: {
  leadModel: string;
  makerModel: string;
  checkerModel: string;
}): RuntimePolicyV1[] {
  const policy = (
    policyName: string,
    primaryModel: string,
    requiredCapabilities: RuntimePolicyV1['requiredCapabilities'],
    maxAttempts: number,
  ): RuntimePolicyV1 => RuntimePolicySchemaV1.parse({
    identity: { policyName, policyVersion: 1 },
    requiredCapabilities,
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
    policy('reporting-lead', models.leadModel, ['structured_output', 'tool_calling', 'web_research'], 1),
    policy('reporting-maker', models.makerModel, ['structured_output'], 2),
    policy('reporting-checker', models.checkerModel, ['structured_output'], 2),
  ];
}
