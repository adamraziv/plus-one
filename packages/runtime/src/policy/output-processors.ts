import {
  OrchestratorFinalResponseSchemaV1,
  OutputProcessorResultSchemaV1,
  type OrchestratorFinalResponseV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';

export interface OutputProcessor {
  name: string;
  version: number;
  process(response: OrchestratorFinalResponseV1): OutputProcessorResultV1;
}

function result(
  processorName: string,
  processorVersion: number,
  status: 'passed' | 'blocked',
  reason: string,
  issues: string[] = [],
  retryable = status === 'blocked',
): OutputProcessorResultV1 {
  return OutputProcessorResultSchemaV1.parse({
    schemaName: 'output-processor-result',
    schemaVersion: 1,
    processorName,
    processorVersion,
    status,
    reason,
    issues,
    retryable,
  });
}

function schemaBlocked(processorName: string, processorVersion: number): OutputProcessorResultV1 {
  return result(processorName, processorVersion, 'blocked', 'Final response failed structured validation.',
    ['schema_validation'], false);
}

export const mandatoryPolicyProcessor: OutputProcessor = {
  name: 'mandatory-policy',
  version: 1,
  process(candidate) {
    const parsed = OrchestratorFinalResponseSchemaV1.safeParse(candidate);
    if (!parsed.success) return schemaBlocked(this.name, this.version);
    const response = parsed.data;
    const disclaimer = response.disclaimer.toLowerCase();

    if (response.unsupportedCapabilities.length > 0
      && response.policyBoundary !== 'unsupported_capability') {
      return result(this.name, this.version, 'blocked',
        'Unsupported tax or insurance content must use the unsupported-capability boundary.',
        ['unsupported_capability_not_declared']);
    }
    if (response.policyBoundary === 'unsupported_capability') {
      if (response.unsupportedCapabilities.length === 0) {
        return result(this.name, this.version, 'blocked',
          'Unsupported-capability responses must name the unsupported capability.',
          ['unsupported_capability_missing']);
      }
      if (response.recommendationActions.length > 0) {
        return result(this.name, this.version, 'blocked',
          'Unsupported capabilities cannot include recommendation actions.',
          ['unsupported_recommendation_action']);
      }
      return result(this.name, this.version, 'passed', 'Unsupported capability boundary is explicit.');
    }
    if (response.policyBoundary === 'informational_only'
      && response.recommendationActions.length > 0) {
      return result(this.name, this.version, 'blocked',
        'Informational-only responses cannot include recommendation actions.',
        ['informational_recommendation_action']);
    }
    if (!disclaimer.includes('not a licensed financial professional')) {
      return result(this.name, this.version, 'blocked',
        'Financial responses must include the mandatory professional disclaimer.',
        ['missing_financial_professional_disclaimer']);
    }
    if (response.freshness.some((item) => item.toLowerCase().includes('stale'))) {
      return result(this.name, this.version, 'blocked',
        'Response freshness is stale.',
        ['stale_freshness']);
    }
    return result(this.name, this.version, 'passed', 'Mandatory policy checks passed.');
  },
};

export const channelFormatProcessor: OutputProcessor = {
  name: 'channel-format',
  version: 1,
  process(candidate) {
    const parsed = OrchestratorFinalResponseSchemaV1.safeParse(candidate);
    if (!parsed.success) return schemaBlocked(this.name, this.version);
    const response = parsed.data;
    if (response.delivery.channel === 'telegram') {
      if (typeof response.delivery.destination.chatId !== 'string') {
        return result(this.name, this.version, 'blocked',
          'Telegram delivery requires chatId destination metadata.',
          ['telegram_chat_id_missing']);
      }
      if (response.body.length > 4096) {
        return result(this.name, this.version, 'blocked',
          'Telegram body exceeds the platform message limit.',
          ['telegram_body_too_long']);
      }
    }
    if (response.delivery.channel === 'slack') {
      if (typeof response.delivery.destination.channelId !== 'string') {
        return result(this.name, this.version, 'blocked',
          'Slack delivery requires channelId destination metadata.',
          ['slack_channel_id_missing']);
      }
      if (response.body.length > 40_000) {
        return result(this.name, this.version, 'blocked',
          'Slack body exceeds the platform message limit.',
          ['slack_body_too_long']);
      }
    }
    return result(this.name, this.version, 'passed', 'Channel formatting checks passed.');
  },
};

export function runOutputProcessors(
  response: OrchestratorFinalResponseV1,
  processors: readonly OutputProcessor[] = [mandatoryPolicyProcessor, channelFormatProcessor],
): OutputProcessorResultV1 {
  for (const processor of processors) {
    const processed = processor.process(response);
    if (processed.status === 'blocked') return processed;
  }
  return result('processor-chain', 1, 'passed', 'All output processors passed.', [], false);
}
