export interface CommandDefinition {
  id: string;
  help: readonly { usage: string; description: string }[];
  matches(argv: string[]): boolean;
  run(argv: string[], context: CommandContext): Promise<number>;
}

export interface CommandContext {
  operations: {
    status(): Promise<number>;
    stop(): Promise<number>;
    live(): Promise<number>;
    logs(argv: string[]): Promise<number>;
    telegramPairing(argv: string[]): Promise<number>;
    foreground(): Promise<number>;
  };
}

export const commandRegistry: readonly CommandDefinition[];
export function isHelpRequest(argv: string[]): boolean;
export function renderHelp(): string;
