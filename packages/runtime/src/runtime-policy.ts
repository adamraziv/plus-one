import {
  PlusOneError,
  RuntimePolicyIdentitySchemaV1,
  RuntimePolicySchemaV1,
  type RuntimePolicyV1,
} from '@plus-one/contracts';

type Capability = RuntimePolicyV1['requiredCapabilities'][number];

export class RuntimePolicyRegistry {
  private readonly policies = new Map<string, RuntimePolicyV1>();
  private readonly models: Readonly<Record<string, readonly Capability[]>>;

  constructor(input: {
    models: Readonly<Record<string, readonly Capability[]>>;
    policies: readonly RuntimePolicyV1[];
  }) {
    this.models = input.models;

    for (const candidate of input.policies) {
      const policy = RuntimePolicySchemaV1.parse(candidate);

      for (const model of [policy.primaryModel, ...policy.fallbackModels]) {
        const capabilities = this.models[model];
        const missing = policy.requiredCapabilities.filter(
          (capability) => !capabilities?.includes(capability),
        );

        if (missing.length > 0) {
          throw new PlusOneError({
            category: 'validation_rejected',
            code: 'model_capability_mismatch',
            message: `${model} is missing required capabilities: ${missing.join(', ')}`,
            retry: 'never',
            receiptLookupRequired: false,
            details: { model, missing: missing.join(',') },
          });
        }
      }

      const key = this.key(policy.identity);
      if (this.policies.has(key)) {
        throw new Error(`Duplicate runtime policy ${key}`);
      }

      this.policies.set(key, policy);
    }
  }

  resolve(identity: RuntimePolicyV1['identity']): RuntimePolicyV1 {
    const parsed = RuntimePolicyIdentitySchemaV1.parse(identity);
    const policy = this.policies.get(this.key(parsed));

    if (policy === undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'runtime_policy_not_found',
        message: 'Runtime policy was not found',
        retry: 'never',
        receiptLookupRequired: false,
        details: {
          policyName: parsed.policyName,
          policyVersion: parsed.policyVersion,
        },
      });
    }

    return structuredClone(policy);
  }

  private key(identity: RuntimePolicyV1['identity']): string {
    return `${identity.policyName}@${identity.policyVersion}`;
  }
}
