import type {
  CheckerVerdictV1,
  RuntimePolicyV1,
  TaskStatusV1,
} from '@plus-one/contracts';

export interface VerificationTaskSnapshot {
  householdId: string;
  taskId: string;
  parentTaskId?: string;
  team: string;
  status: TaskStatusV1;
  attemptLimit: number;
  deadlineAt?: string;
  failureCategory?: string;
  resumable: boolean;
  currentMakerArtifactId?: string;
  currentMakerArtifactHash?: string;
  currentCheckerArtifactId?: string;
  updatedAt: string;
}

export interface VerificationLedgerPort {
  createTask(input: {
    householdId: string;
    taskId: string;
    parentTaskId?: string;
    team: string;
    attemptLimit: number;
    deadlineAt?: string;
  }): Promise<VerificationTaskSnapshot>;
  selectExecutionContract(input: {
    householdId: string;
    taskId: string;
    skill: { skillName: string; skillVersion: number; contentHash: string };
    inputSchema: { schemaName: string; schemaVersion: number };
    outputSchema: { schemaName: string; schemaVersion: number };
    policy: RuntimePolicyV1;
  }): Promise<void>;
  transition(input: {
    householdId: string;
    taskId: string;
    expectedFrom: TaskStatusV1;
    to: TaskStatusV1;
    reasonCode: string;
    responsibleComponent: string;
    terminal?: boolean;
    failureCategory?: string;
    resumable?: boolean;
  }): Promise<VerificationTaskSnapshot>;
  linkMakerArtifact(input: {
    householdId: string;
    taskId: string;
    artifactId: string;
    artifactHash: string;
  }): Promise<void>;
  recordCheckerVerdict(input: {
    householdId: string;
    taskId: string;
    checkerArtifactId: string;
    verdict: CheckerVerdictV1;
  }): Promise<void>;
  startRun(input: {
    householdId: string;
    taskId: string;
    runId: string;
    role: string;
    roleVersion: number;
    modelId: string;
    policy: RuntimePolicyV1;
  }): Promise<void>;
  finishRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    failureCategory?: string,
  ): Promise<void>;
  startAttempt(input: {
    householdId: string;
    taskId: string;
    runId: string;
    role: string;
    ordinal: number;
    configuredLimit: number;
    resumable: boolean;
  }): Promise<void>;
  finishAttempt(input: {
    householdId: string;
    taskId: string;
    role: string;
    ordinal: number;
    outcome:
      | 'succeeded'
      | 'schema_failed'
      | 'model_failed'
      | 'tool_failed'
      | 'timed_out'
      | 'cancelled';
    retryCategory?: string;
    resumable: boolean;
  }): Promise<void>;
  findLatestVerdict(
    householdId: string,
    taskId: string,
  ): Promise<CheckerVerdictV1 | undefined>;
  findTask(
    householdId: string,
    taskId: string,
  ): Promise<VerificationTaskSnapshot | undefined>;
  listResumable(): Promise<VerificationTaskSnapshot[]>;
}
