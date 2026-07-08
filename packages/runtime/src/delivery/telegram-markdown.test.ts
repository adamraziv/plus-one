import { describe, expect, it } from 'vitest';
import { toTelegramMarkdownV2 } from './telegram-markdown.js';

describe('Telegram MarkdownV2 formatting', () => {
  it('escapes Telegram MarkdownV2 metacharacters in plain text', () => {
    expect(toTelegramMarkdownV2('Budget + cash-flow (July).')).toBe('Budget \\+ cash\\-flow \\(July\\)\\.');
  });

  it('escapes literal backslashes in non-code MarkdownV2 text', () => {
    expect(toTelegramMarkdownV2('Path C:\\Users\\Ada and **regex \\d+**.'))
      .toBe('Path C:\\\\Users\\\\Ada and *regex \\\\d\\+*\\.');
  });

  it('converts common markdown emphasis and headings', () => {
    expect(toTelegramMarkdownV2('## Summary\nYou are **under budget**.')).toBe('*Summary*\nYou are *under budget*\\.');
  });

  it('preserves inline code using Telegram code delimiters', () => {
    expect(toTelegramMarkdownV2('Use `checking_account` for this.')).toBe('Use `checking_account` for this\\.');
  });

  it('converts italic markdown into Telegram italic delimiters', () => {
    expect(toTelegramMarkdownV2('This is *important*.')).toBe('This is _important_\\.');
  });

  it('converts markdown links into Telegram MarkdownV2 links', () => {
    expect(toTelegramMarkdownV2('See [budget](https://example.test/report).'))
      .toBe('See [budget](https://example.test/report)\\.');
  });
});
