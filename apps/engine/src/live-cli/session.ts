import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import {
  createInitialLiveCliState,
  handleLiveCliKey,
  setRuntimeStatus,
  setStatusMessage,
  snapshotLiveCliState,
} from './menu-model.js';
import { detectColorSupport, renderLiveCliSnapshot } from './renderer.js';
import type { LiveCliAction, LiveCliKey, RuntimeStatus } from './types.js';

interface Input extends EventEmitter {
  isTTY?: boolean;
  setRawMode?: (value: boolean) => void;
  resume?: () => void;
  pause?: () => void;
}

interface Output {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): void;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

interface RuntimePort {
  detect(): Promise<RuntimeStatus>;
  currentStatus(): RuntimeStatus;
  start(): Promise<{ status: RuntimeStatus; message?: string }>;
  stop(): Promise<{ status: RuntimeStatus; message?: string }>;
  hideToBackground(): Promise<{ status: RuntimeStatus; message?: string }>;
}

interface TelegramPort {
  status(): string;
  listPending(): Promise<string>;
  approve(code: string, householdId: string): Promise<string>;
  revoke(telegramUserId: string): Promise<string>;
}

export async function runLiveCliSession(input: {
  stdin: Input;
  stdout: Output;
  stderr: { write(text: string): void };
  environment: Record<string, string | undefined>;
  runtime: RuntimePort;
  telegram: TelegramPort;
}): Promise<number> {
  const color = detectColorSupport(input.environment);
  let state = createInitialLiveCliState({ runtimeStatus: input.runtime.currentStatus() });
  let finished = false;
  const exitCode = 0;

  const render = () => {
    input.stdout.write('\u001b[?25l\u001b[H\u001b[2J');
    input.stdout.write(renderLiveCliSnapshot({
      snapshot: snapshotLiveCliState(state),
      size: {
        columns: input.stdout.columns ?? 80,
        rows: input.stdout.rows ?? 24,
      },
      color,
    }));
  };

  const finish = async (options: { stopRuntime: boolean }) => {
    if (finished) return;
    finished = true;
    if (options.stopRuntime) {
      await input.runtime.stop();
      state = setRuntimeStatus(state, 'stopped');
    }
    restoreTerminal(input.stdin, input.stdout);
  };

  const applyAction = async (action: LiveCliAction): Promise<void> => {
    if (action.type === 'none') return;
    if (action.type === 'start-runtime') {
      state = setRuntimeStatus(state, 'starting');
      render();
      const result = await input.runtime.start();
      state = setRuntimeStatus(state, result.status);
      if (result.message !== undefined) state = setStatusMessage(state, result.message);
      return;
    }
    if (action.type === 'stop-runtime') {
      state = setRuntimeStatus(state, 'stopping');
      render();
      const result = await input.runtime.stop();
      state = setRuntimeStatus(state, result.status);
      if (result.message !== undefined) state = setStatusMessage(state, result.message);
      return;
    }
    if (action.type === 'hide-runtime') {
      const result = await input.runtime.hideToBackground();
      state = setRuntimeStatus(state, result.status);
      if (result.message !== undefined) {
        state = setStatusMessage(state, result.message);
        return;
      }
      await finish({ stopRuntime: false });
      return;
    }
    if (action.type === 'exit') {
      await finish({ stopRuntime: true });
      return;
    }
    if (action.type === 'telegram-status') {
      state = setStatusMessage(state, input.telegram.status());
      return;
    }
    if (action.type === 'telegram-list-pending') {
      state = setStatusMessage(state, await input.telegram.listPending());
      return;
    }
    if (action.type === 'telegram-approve') {
      state = setStatusMessage(state, 'Use direct command: plus-one telegram pairing approve <code> --household <household_id>');
      return;
    }
    if (action.type === 'telegram-revoke') {
      state = setStatusMessage(state, 'Use direct command: plus-one telegram pairing revoke <telegram_user_id>');
    }
  };

  let actionQueue = Promise.resolve();
  const keyHandler = (_chunk: string, key: LiveCliKey) => {
    actionQueue = actionQueue.then(async () => {
      const result = handleLiveCliKey(state, key);
      state = result.state;
      await applyAction(result.action);
      if (!finished) render();
    }).catch((error: unknown) => {
      state = setStatusMessage(state, error instanceof Error ? error.message : String(error));
      render();
    });
  };

  const resizeHandler = () => render();
  const sigintHandler = () => {
    void finish({ stopRuntime: true });
  };

  readline.emitKeypressEvents(input.stdin as never);
  input.stdin.setRawMode?.(true);
  input.stdin.resume?.();
  input.stdin.on('keypress', keyHandler);
  input.stdout.on?.('resize', resizeHandler);
  process.once('SIGINT', sigintHandler);

  render();

  input.runtime.detect()
    .then((status) => {
      state = setRuntimeStatus(state, status);
      if (!finished) render();
    })
    .catch((error: unknown) => {
      state = setStatusMessage(state, error instanceof Error ? error.message : String(error));
      if (!finished) render();
    });

  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  input.stdin.off('keypress', keyHandler);
  input.stdout.off?.('resize', resizeHandler);
  process.off('SIGINT', sigintHandler);
  return exitCode;
}

function restoreTerminal(stdin: Input, stdout: { write(text: string): void }): void {
  stdin.setRawMode?.(false);
  stdin.pause?.();
  stdout.write('\u001b[?25h');
}
