const TELEGRAM_MARKDOWN_V2_META = /[_*[\]()~`>#+\-=|{}.!]/g;

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
    const code = /`([^`]+)`/.exec(remaining);
    const bold = /\*\*([^*]+)\*\*/.exec(remaining);
    const next = [code, bold]
      .filter((match): match is RegExpExecArray => match !== null)
      .sort((left, right) => left.index - right.index)[0];
    if (next === undefined) {
      segments.push(escapeTelegramMarkdownV2(remaining));
      break;
    }
    segments.push(escapeTelegramMarkdownV2(remaining.slice(0, next.index)));
    if (next === code) {
      segments.push(`\`${(next[1] ?? '').replace(/[`\\]/g, (match) => `\\${match}`)}\``);
    } else {
      segments.push(`*${escapeTelegramMarkdownV2(next[1] ?? '')}*`);
    }
    remaining = remaining.slice(next.index + next[0].length);
  }
  return segments.join('');
}
