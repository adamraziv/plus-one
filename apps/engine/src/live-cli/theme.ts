export type ColorSupport = 'none' | 'ansi16' | 'ansi256' | 'truecolor';

export type SemanticStyle =
  | 'fg.default'
  | 'fg.muted'
  | 'fg.emphasis'
  | 'bg.selection'
  | 'accent.primary'
  | 'status.error'
  | 'status.warning'
  | 'status.success'
  | 'status.info';

const ANSI16: Record<SemanticStyle, [number, number]> = {
  'fg.default': [37, 39],
  'fg.muted': [2, 22],
  'fg.emphasis': [1, 22],
  'bg.selection': [7, 27],
  'accent.primary': [36, 39],
  'status.error': [31, 39],
  'status.warning': [33, 39],
  'status.success': [32, 39],
  'status.info': [36, 39],
};

export function detectColorSupport(environment: Record<string, string | undefined>): ColorSupport {
  if (environment.NO_COLOR !== undefined) return 'none';
  if (environment.COLORTERM === 'truecolor' || environment.COLORTERM === '24bit') return 'truecolor';
  if (environment.TERM?.includes('256color') === true) return 'ansi256';
  return 'ansi16';
}

export function styleText(text: string, style: SemanticStyle, color: ColorSupport): string {
  if (color === 'none') return text;
  const [open, close] = ANSI16[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}
