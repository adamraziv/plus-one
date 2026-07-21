const TELEGRAM_MARKDOWN_V2_META = /[\\_*[\]()~`>#+\-=|{}.!]/g;

export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(TELEGRAM_MARKDOWN_V2_META, (match) => `\\${match}`);
}

export function toTelegramMarkdownV2(markdown: string): string {
  return markdown
    .split('\n')
    .map(formatLine)
    .join('\n');
}

function formatLine(line: string): string {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading !== null) return `*${escapeTelegramMarkdownV2(heading[2] ?? '')}*`;

  const segments: string[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    const next = nextInlineToken(remaining);
    if (next === undefined) {
      segments.push(escapeTelegramMarkdownV2(remaining));
      break;
    }
    segments.push(escapeTelegramMarkdownV2(remaining.slice(0, next.index)));
    segments.push(next.formatted);
    remaining = remaining.slice(next.index + next.raw.length);
  }
  return segments.join('');
}

function nextInlineToken(text: string): { index: number; raw: string; formatted: string } | undefined {
  const tokens = [
    token(text, /`([^`]+)`/, (match) => `\`${(match[1] ?? '').replace(/[`\\]/g, (value) => `\\${value}`)}\``),
    token(text, /\[([^\]]+)\]\(([^)]+)\)/, (match) => `[${escapeTelegramMarkdownV2(match[1] ?? '')}](${escapeTelegramMarkdownV2LinkUrl(match[2] ?? '')})`),
    token(text, /\*\*([^*]+)\*\*/, (match) => `*${escapeTelegramMarkdownV2(match[1] ?? '')}*`),
    token(text, /(?<!\*)\*([^*\n]+)\*(?!\*)/, (match) => `_${escapeTelegramMarkdownV2(match[1] ?? '')}_`),
  ].filter((match): match is { index: number; raw: string; formatted: string } => match !== undefined);

  return tokens.sort((left, right) => left.index - right.index)[0];
}

function token(
  text: string,
  pattern: RegExp,
  format: (match: RegExpExecArray) => string,
): { index: number; raw: string; formatted: string } | undefined {
  const match = pattern.exec(text);
  if (match === null) return undefined;
  return { index: match.index, raw: match[0], formatted: format(match) };
}

function escapeTelegramMarkdownV2LinkUrl(url: string): string {
  return url.replace(/[)\\]/g, (match) => `\\${match}`);
}
