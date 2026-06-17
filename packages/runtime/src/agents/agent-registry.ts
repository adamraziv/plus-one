import type { Agent } from '@mastra/core/agent';
import { PlusOneError } from '@plus-one/contracts';
import type { TeamRoleKind } from '../teams/definitions.js';

export interface AgentRegistration {
  agentId: string;
  modelId: string;
  roleKind: TeamRoleKind;
  memoryEnabled: boolean;
  agent: Agent;
}

export class AgentRegistry {
  private readonly registrations = new Map<string, AgentRegistration>();

  register(registration: AgentRegistration): void {
    if (registration.roleKind === 'checker' && registration.memoryEnabled) {
      throw this.error('checker_memory_forbidden', 'Checker agents must be registered without memory');
    }
    const key = this.key(registration.agentId, registration.modelId);
    if (this.registrations.has(key)) {
      throw this.error('duplicate_agent_registration', 'Agent/model pair already exists');
    }
    this.registrations.set(key, registration);
  }

  resolve(agentId: string, modelId: string, roleKind: TeamRoleKind): AgentRegistration {
    const registration = this.registrations.get(this.key(agentId, modelId));
    if (registration === undefined || registration.roleKind !== roleKind) {
      throw this.error('agent_not_registered', 'Agent/model registration is absent or has the wrong role kind');
    }
    return registration;
  }

  private key(agentId: string, modelId: string): string {
    return agentId + ':' + modelId;
  }

  private error(code: string, message: string): PlusOneError {
    return new PlusOneError({ category: 'policy_rejected', code, message, retry: 'never',
      receiptLookupRequired: false, details: {} });
  }
}
