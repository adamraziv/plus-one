export type RuntimeStatus = 'stopped' | 'starting' | 'running-attached' | 'running-background' | 'stopping';

export type LiveCliScreen = 'main' | 'socials' | 'telegram';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface LiveCliKey {
  name: string;
  sequence?: string;
}

export type LiveCliPromptKind = 'telegram-approve-code' | 'telegram-approve-household' | 'telegram-revoke-user';

export interface LiveCliPrompt {
  kind: LiveCliPromptKind;
  label: string;
  value: string;
  context?: {
    code?: string;
  };
}

export type LiveCliAction =
  | { type: 'none' }
  | { type: 'start-runtime' }
  | { type: 'stop-runtime' }
  | { type: 'hide-runtime' }
  | { type: 'exit' }
  | { type: 'telegram-status' }
  | { type: 'telegram-list-pending' }
  | { type: 'telegram-approve'; code: string; householdId: string }
  | { type: 'telegram-revoke'; telegramUserId: string };

export interface LiveCliMenuItem {
  label: string;
  action: LiveCliAction;
}

export interface LiveCliOverlay {
  kind: 'help';
  title: string;
  lines: string[];
}

export interface LiveCliSnapshot {
  title: string;
  runtimeStatus: RuntimeStatus;
  selectedIndex: number;
  items: LiveCliMenuItem[];
  footer: string;
  statusMessage?: string;
  overlay?: LiveCliOverlay;
  prompt?: LiveCliPrompt;
}

export interface LiveCliState {
  screen: LiveCliScreen;
  runtimeStatus: RuntimeStatus;
  selectedIndex: number;
  statusMessage?: string;
  overlay?: LiveCliOverlay;
  prompt?: LiveCliPrompt;
}
