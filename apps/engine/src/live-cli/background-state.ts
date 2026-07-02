import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const BackgroundRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  enginePid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  logFilePath: z.string().min(1).optional(),
});

export type BackgroundRuntimeState = z.infer<typeof BackgroundRuntimeStateSchema>;

export interface BackgroundStateFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, value: string, encoding: 'utf8'): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

const nodeFileSystem: BackgroundStateFileSystem = { mkdir, readFile, writeFile, unlink };

export function defaultBackgroundStatePath(
  environment: Record<string, string | undefined> = process.env,
): string {
  if (environment.PLUS_ONE_LIVE_CLI_STATE_FILE !== undefined) return environment.PLUS_ONE_LIVE_CLI_STATE_FILE;
  const stateHome = environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(stateHome, 'plus-one', 'live-cli.json');
}

export async function saveBackgroundRuntimeState(input: {
  path: string;
  state: BackgroundRuntimeState;
  fileSystem?: BackgroundStateFileSystem;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const state = BackgroundRuntimeStateSchema.parse(input.state);
  await fileSystem.mkdir(dirname(input.path), { recursive: true });
  await fileSystem.writeFile(input.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function loadBackgroundRuntimeState(input: {
  path: string;
  fileSystem?: BackgroundStateFileSystem;
  isProcessAlive?: (pid: number) => boolean;
}): Promise<BackgroundRuntimeState | undefined> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  let raw: string;
  try {
    raw = await fileSystem.readFile(input.path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    await clearBackgroundRuntimeState({ path: input.path, fileSystem });
    return undefined;
  }

  const parsed = BackgroundRuntimeStateSchema.safeParse(decoded);
  if (!parsed.success) {
    await clearBackgroundRuntimeState({ path: input.path, fileSystem });
    return undefined;
  }

  if ((input.isProcessAlive ?? defaultIsProcessAlive)(parsed.data.enginePid)) return parsed.data;
  await clearBackgroundRuntimeState({ path: input.path, fileSystem });
  return undefined;
}

export async function clearBackgroundRuntimeState(input: {
  path: string;
  fileSystem?: BackgroundStateFileSystem;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  try {
    await fileSystem.unlink(input.path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
