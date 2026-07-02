import type {
  LiveCliAction,
  LiveCliKey,
  LiveCliMenuItem,
  LiveCliSnapshot,
  LiveCliState,
  RuntimeStatus,
} from './types.js';

export function createInitialLiveCliState(input: {
  runtimeStatus: RuntimeStatus;
  selectedIndex?: number;
  statusMessage?: string;
}): LiveCliState {
  return {
    screen: 'main',
    runtimeStatus: input.runtimeStatus,
    selectedIndex: input.selectedIndex ?? 0,
    ...(input.statusMessage === undefined ? {} : { statusMessage: input.statusMessage }),
  };
}

export function snapshotLiveCliState(state: LiveCliState): LiveCliSnapshot {
  const items = menuItemsFor(state);
  return {
    title: titleFor(state.screen),
    runtimeStatus: state.runtimeStatus,
    selectedIndex: clamp(state.selectedIndex, 0, Math.max(items.length - 1, 0)),
    items,
    footer: footerFor(state.screen),
    ...(state.statusMessage === undefined ? {} : { statusMessage: state.statusMessage }),
    ...(state.overlay === undefined ? {} : { overlay: state.overlay }),
    ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
  };
}

export function setRuntimeStatus(state: LiveCliState, runtimeStatus: RuntimeStatus): LiveCliState {
  return { ...state, runtimeStatus };
}

export function setStatusMessage(state: LiveCliState, statusMessage: string): LiveCliState {
  return { ...state, statusMessage };
}

export function handleLiveCliKey(state: LiveCliState, key: LiveCliKey): {
  state: LiveCliState;
  action: LiveCliAction;
} {
  if (state.prompt !== undefined) {
    if (key.name === 'escape') {
      return { state: withoutPrompt(state), action: { type: 'none' } };
    }
    if (key.name === 'backspace') {
      return {
        state: { ...state, prompt: { ...state.prompt, value: state.prompt.value.slice(0, -1) } },
        action: { type: 'none' },
      };
    }
    if (key.name === 'enter' || key.name === 'return') {
      if (state.prompt.kind === 'telegram-approve-code') {
        return {
          state: {
            ...state,
            prompt: {
              kind: 'telegram-approve-household',
              label: 'Household id',
              value: '',
              context: { code: state.prompt.value },
            },
          },
          action: { type: 'none' },
        };
      }
      if (state.prompt.kind === 'telegram-approve-household') {
        return {
          state: withoutPrompt(state),
          action: {
            type: 'telegram-approve',
            code: state.prompt.context?.code ?? '',
            householdId: state.prompt.value,
          },
        };
      }
      return {
        state: withoutPrompt(state),
        action: { type: 'telegram-revoke', telegramUserId: state.prompt.value },
      };
    }
    const character = key.sequence ?? key.name;
    if (character.length === 1 && character >= ' ') {
      return {
        state: { ...state, prompt: { ...state.prompt, value: `${state.prompt.value}${character}` } },
        action: { type: 'none' },
      };
    }
    return { state, action: { type: 'none' } };
  }

  if (state.overlay !== undefined) {
    if (key.name === 'escape' || key.name === 'q' || key.name === '?') {
      return { state: withoutOverlay(state), action: { type: 'none' } };
    }
    return { state, action: { type: 'none' } };
  }

  if (key.name === '?') {
    return {
      state: {
        ...state,
        overlay: {
          kind: 'help',
          title: `${titleFor(state.screen)} help`,
          lines: [
            'Up/Down or j/k moves the selected action.',
            'Enter selects the highlighted action.',
            'Number keys select the matching visible action.',
            'Esc or q goes back, or exits from the main screen.',
            'Ctrl+C stops a running local runtime before exit.',
          ],
        },
      },
      action: { type: 'none' },
    };
  }

  const items = menuItemsFor(state);
  const selectedIndex = clamp(state.selectedIndex, 0, Math.max(items.length - 1, 0));

  if (key.name === 'down' || key.name === 'j') {
    return {
      state: { ...state, selectedIndex: Math.min(selectedIndex + 1, items.length - 1) },
      action: { type: 'none' },
    };
  }

  if (key.name === 'up' || key.name === 'k') {
    return {
      state: { ...state, selectedIndex: Math.max(selectedIndex - 1, 0) },
      action: { type: 'none' },
    };
  }

  if (/^[1-9]$/.test(key.name)) {
    const index = Number.parseInt(key.name, 10) - 1;
    const item = items[index];
    if (item !== undefined) return selectItem(state, item);
    return { state, action: { type: 'none' } };
  }

  if (key.name === 'enter' || key.name === 'return') {
    const item = items[selectedIndex] ?? items[0];
    if (item !== undefined) return selectItem(state, item);
    return { state, action: { type: 'none' } };
  }

  if (key.name === 'escape' || key.name === 'q') {
    if (state.screen === 'main') return { state, action: { type: 'exit' } };
    return {
      state: {
        ...state,
        screen: state.screen === 'telegram' ? 'socials' : 'main',
        selectedIndex: 0,
      },
      action: { type: 'none' },
    };
  }

  return { state, action: { type: 'none' } };
}

function selectItem(state: LiveCliState, item: LiveCliMenuItem): {
  state: LiveCliState;
  action: LiveCliAction;
} {
  if (item.action.type === 'none' && item.label === 'Configure socials') {
    return { state: { ...state, screen: 'socials', selectedIndex: 0 }, action: { type: 'none' } };
  }
  if (item.action.type === 'none' && item.label === 'Telegram') {
    return { state: { ...state, screen: 'telegram', selectedIndex: 0 }, action: { type: 'none' } };
  }
  if (item.action.type === 'none' && item.label === 'Back') {
    return {
      state: {
        ...state,
        screen: state.screen === 'telegram' ? 'socials' : 'main',
        selectedIndex: 0,
      },
      action: { type: 'none' },
    };
  }
  if (item.action.type === 'telegram-approve') {
    return {
      state: {
        ...state,
        prompt: { kind: 'telegram-approve-code', label: 'Pairing code', value: '' },
      },
      action: { type: 'none' },
    };
  }
  if (item.action.type === 'telegram-revoke') {
    return {
      state: {
        ...state,
        prompt: { kind: 'telegram-revoke-user', label: 'Telegram user id', value: '' },
      },
      action: { type: 'none' },
    };
  }
  return { state, action: item.action };
}

function menuItemsFor(state: LiveCliState): LiveCliMenuItem[] {
  if (state.screen === 'socials') {
    return [
      { label: 'Telegram', action: { type: 'none' } },
      { label: 'Back', action: { type: 'none' } },
    ];
  }

  if (state.screen === 'telegram') {
    return [
      { label: 'Status', action: { type: 'telegram-status' } },
      { label: 'List pending pairings', action: { type: 'telegram-list-pending' } },
      { label: 'Approve pairing code', action: { type: 'telegram-approve', code: '', householdId: '' } },
      { label: 'Revoke user', action: { type: 'telegram-revoke', telegramUserId: '' } },
      { label: 'Back', action: { type: 'none' } },
    ];
  }

  return [
    {
      label: state.runtimeStatus === 'stopped' ? 'Start' : 'Stop',
      action: state.runtimeStatus === 'stopped' ? { type: 'start-runtime' } : { type: 'stop-runtime' },
    },
    { label: 'Hide to background', action: { type: 'hide-runtime' } },
    { label: 'Configure socials', action: { type: 'none' } },
    { label: 'Exit', action: { type: 'exit' } },
  ];
}

function titleFor(screen: LiveCliState['screen']): string {
  if (screen === 'socials') return 'Plus One / Configure socials';
  if (screen === 'telegram') return 'Plus One / Configure socials / Telegram';
  return 'Plus One';
}

function footerFor(screen: LiveCliState['screen']): string {
  if (screen === 'main') return '[Enter] select  [j/k] move  [Esc/q] exit  [?] help';
  return '[Enter] select  [j/k] move  [Esc/q] back  [?] help';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function withoutPrompt(state: LiveCliState): LiveCliState {
  return {
    screen: state.screen,
    runtimeStatus: state.runtimeStatus,
    selectedIndex: state.selectedIndex,
    ...(state.statusMessage === undefined ? {} : { statusMessage: state.statusMessage }),
    ...(state.overlay === undefined ? {} : { overlay: state.overlay }),
  };
}

function withoutOverlay(state: LiveCliState): LiveCliState {
  return {
    screen: state.screen,
    runtimeStatus: state.runtimeStatus,
    selectedIndex: state.selectedIndex,
    ...(state.statusMessage === undefined ? {} : { statusMessage: state.statusMessage }),
    ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
  };
}
