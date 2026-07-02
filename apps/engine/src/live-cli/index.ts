import type { ReadStream, WriteStream } from 'node:tty';

interface Output {
  write(text: string): void;
}

export interface RunLiveCliDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdin?: NodeJS.ReadStream | ReadStream | { isTTY?: boolean };
  stdout?: Output | WriteStream;
  stderr?: Output | WriteStream;
}

export async function runLiveCli(dependencies: RunLiveCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  stdout.write('Plus One live CLI is not implemented yet.\n');
  return 0;
}
