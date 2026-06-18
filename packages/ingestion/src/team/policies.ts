import { RuntimePolicySchemaV1, type RuntimePolicyV1 } from '@plus-one/contracts';
import { ingestionRoles } from './roles.js';

export function createIngestionRuntimePolicies(models: { maker: string; checker: string }): RuntimePolicyV1[] {
  return ingestionRoles.map((role) => RuntimePolicySchemaV1.parse({
    identity: { policyName: `${role.identity.roleName}-policy`, policyVersion: 1 },
    requiredCapabilities: ['structured_output'],
    primaryModel: role.kind === 'checker' ? models.checker : models.maker,
    fallbackModels: [],
    maxModelSteps: 4,
    maxToolConcurrency: 1,
    maxAttempts: 2,
    maxModelRequestRetries: 1,
    maxProcessorRetries: 0,
    maxSandboxReproductions: 0,
    callDeadlineMs: 20_000,
    teamDeadlineMs: 60_000,
    endToEndDeadlineMs: 90_000,
    maxOutputBytes: 128_000,
  }));
}
