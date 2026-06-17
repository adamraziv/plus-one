import { PlusOneError, SkillIdentitySchemaV1, type SkillIdentityV1 } from '@plus-one/contracts';
import { hashArtifact } from '../canonical-json.js';

export interface SkillRegistration {
  identity: SkillIdentityV1;
  content: string;
  allowedTeams: readonly string[];
  allowedRoles: readonly string[];
  makerInstructions: readonly string[];
  checkerRubric: readonly string[];
}

export function createSkillRegistration(input: {
  skillName: string;
  skillVersion: number;
  content: string;
  allowedTeams: readonly string[];
  allowedRoles: readonly string[];
  makerInstructions: readonly string[];
  checkerRubric: readonly string[];
}): SkillRegistration {
  const contentHash = hashArtifact({
    content: input.content,
    makerInstructions: [...input.makerInstructions],
    checkerRubric: [...input.checkerRubric],
  });
  return {
    identity: SkillIdentitySchemaV1.parse({
      skillName: input.skillName, skillVersion: input.skillVersion, contentHash,
    }),
    content: input.content,
    allowedTeams: input.allowedTeams,
    allowedRoles: input.allowedRoles,
    makerInstructions: input.makerInstructions,
    checkerRubric: input.checkerRubric,
  };
}

export class SkillRegistry {
  private readonly registrations = new Map<string, SkillRegistration>();

  constructor(initial: readonly SkillRegistration[] = []) {
    for (const registration of initial) this.register(registration);
  }

  register(registration: SkillRegistration): void {
    const expected = createSkillRegistration({
      skillName: registration.identity.skillName,
      skillVersion: registration.identity.skillVersion,
      content: registration.content,
      allowedTeams: registration.allowedTeams,
      allowedRoles: registration.allowedRoles,
      makerInstructions: registration.makerInstructions,
      checkerRubric: registration.checkerRubric,
    });
    if (expected.identity.contentHash !== registration.identity.contentHash) {
      throw this.error('skill_content_hash_mismatch', 'Skill content does not match its immutable hash');
    }
    const key = this.key(registration.identity);
    if (this.registrations.has(key)) throw this.error('duplicate_skill_version', 'Skill version is already registered');
    this.registrations.set(key, Object.freeze({
      ...registration,
      allowedTeams: Object.freeze([...registration.allowedTeams]),
      allowedRoles: Object.freeze([...registration.allowedRoles]),
      makerInstructions: Object.freeze([...registration.makerInstructions]),
      checkerRubric: Object.freeze([...registration.checkerRubric]),
    }));
  }

  resolve(identity: SkillIdentityV1): SkillRegistration {
    const registration = this.registrations.get(this.key(SkillIdentitySchemaV1.parse(identity)));
    if (registration === undefined) throw this.error('skill_not_registered', 'Selected skill version is not registered');
    return registration;
  }

  assertAllowed(identity: SkillIdentityV1, team: string, roleName: string): SkillRegistration {
    const skill = this.resolve(identity);
    if (!skill.allowedTeams.includes(team) || !skill.allowedRoles.includes(roleName)) {
      throw this.error('skill_not_allowed_for_role', 'Selected skill is not allowed for this team and role');
    }
    return skill;
  }

  private key(identity: SkillIdentityV1): string {
    return identity.skillName + ':' + identity.skillVersion;
  }

  private error(code: string, message: string): PlusOneError {
    return new PlusOneError({ category: 'policy_rejected', code, message, retry: 'never',
      receiptLookupRequired: false, details: {} });
  }
}
