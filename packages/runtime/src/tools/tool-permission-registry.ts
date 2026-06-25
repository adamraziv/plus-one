import { PlusOneError } from '@plus-one/contracts';

const ProviderToolIdSchema = /^[A-Za-z0-9_-]{1,64}$/;

export interface ToolPermissionRegistration {
  team: string;
  roleName: string;
  roleVersion: number;
  toolIds: readonly string[];
}

export interface ToolPermissionQuery {
  team: string;
  roleName: string;
  roleVersion: number;
}

export function assertProviderToolId(toolId: string): void {
  if (ProviderToolIdSchema.test(toolId)) return;
  throw new PlusOneError({
    category: 'validation_rejected',
    code: 'provider_tool_id_invalid',
    message: 'Tool id must contain only letters, numbers, underscores, or dashes and be 1-64 characters long',
    retry: 'never',
    receiptLookupRequired: false,
    details: { toolId },
  });
}

export class ToolPermissionRegistry {
  private readonly registrations = new Map<string, ToolPermissionRegistration>();

  constructor(initial: readonly ToolPermissionRegistration[] = []) {
    for (const registration of initial) {
      for (const toolId of registration.toolIds) {
        assertProviderToolId(toolId);
      }
      const key = this.key(registration);
      if (this.registrations.has(key)) {
        throw new PlusOneError({ category: 'policy_rejected', code: 'duplicate_tool_permission',
          message: 'Tool permission is already registered', retry: 'never',
          receiptLookupRequired: false, details: { team: registration.team,
            roleName: registration.roleName, roleVersion: registration.roleVersion } });
      }
      this.registrations.set(key, registration);
    }
  }

  resolve(query: ToolPermissionQuery): readonly string[] {
    const registration = this.registrations.get(this.key(query));
    if (registration === undefined) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'tool_permission_denied',
        message: 'No tool permission is registered for this team and role', retry: 'never',
        receiptLookupRequired: false, details: { team: query.team, roleName: query.roleName,
          roleVersion: query.roleVersion } });
    }
    return Object.freeze([...registration.toolIds]);
  }

  private key(query: ToolPermissionQuery): string {
    return query.team + ':' + query.roleName + ':' + query.roleVersion;
  }
}
