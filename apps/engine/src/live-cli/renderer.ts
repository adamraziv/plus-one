import type { LiveCliSnapshot, RuntimeStatus, TerminalSize } from './types.js';
import {
  detectColorSupport as detectSupport,
  styleText,
  type ColorSupport,
} from './theme.js';

export { type ColorSupport };

export function detectColorSupport(environment: Record<string, string | undefined>): ColorSupport {
  return detectSupport(environment);
}

export function renderLiveCliSnapshot(input: {
  snapshot: LiveCliSnapshot;
  size: TerminalSize;
  color: ColorSupport;
}): string {
  if (input.size.columns < 80 || input.size.rows < 24) {
    return 'Terminal too small for Plus One.\nResize to at least 80x24.\n';
  }

  const lines: string[] = [];
  const title = styleText(input.snapshot.title, 'fg.emphasis', input.color);
  const status = `Status: ${runtimeLabel(input.snapshot.runtimeStatus)}`;
  lines.push(`${title}${spaces(Math.max(1, input.size.columns - visibleLength(input.snapshot.title) - visibleLength(status)))}${status}`);
  lines.push('');

  input.snapshot.items.forEach((item, index) => {
    const marker = index === input.snapshot.selectedIndex ? '>' : ' ';
    const line = `${marker} ${index + 1}. ${item.label}`;
    lines.push(index === input.snapshot.selectedIndex
      ? styleText(line, 'bg.selection', input.color)
      : line);
  });

  if (input.snapshot.statusMessage !== undefined) {
    lines.push('');
    lines.push(input.snapshot.statusMessage);
  }

  if (input.snapshot.overlay !== undefined) {
    lines.push('');
    lines.push(styleText(input.snapshot.overlay.title, 'fg.emphasis', input.color));
    for (const line of input.snapshot.overlay.lines) lines.push(line);
  }

  if (input.snapshot.prompt !== undefined) {
    lines.push('');
    lines.push(`${input.snapshot.prompt.label}: ${input.snapshot.prompt.value}`);
    lines.push('Press Enter to submit or Esc to cancel.');
  }

  const footer = styleText(input.snapshot.footer, 'fg.muted', input.color);
  while (lines.length < input.size.rows - 1) lines.push('');
  lines.push(footer);

  return `${lines.map((line) => truncateVisible(line, input.size.columns)).join('\n')}\n`;
}

function runtimeLabel(status: RuntimeStatus): string {
  if (status === 'running-attached' || status === 'running-background') return 'Running';
  if (status === 'starting') return 'Starting';
  if (status === 'stopping') return 'Stopping';
  return 'Stopped';
}

function spaces(count: number): string {
  return ' '.repeat(Math.max(0, count));
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function truncateVisible(text: string, columns: number): string {
  if (visibleLength(text) <= columns) return text;
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  if (columns <= 1) return plain.slice(0, columns);
  return `${plain.slice(0, columns - 3)}...`;
}
