interface SignedPosting { direction: 'debit' | 'credit'; amount: string }

function parts(value: string): { negative: boolean; integer: string; fraction: string } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new TypeError('Expected a canonical decimal string');
  return { negative: match[1] === '-', integer: match[2]!.replace(/^0+(?=\d)/, ''),
    fraction: match[3] ?? '' };
}

function aligned(value: string, scale: number): bigint {
  const parsed = parts(value);
  const magnitude = BigInt(parsed.integer + parsed.fraction.padEnd(scale, '0'));
  return parsed.negative ? -magnitude : magnitude;
}

function format(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const rendered = scale === 0 ? digits : digits.slice(0, -scale) + '.' + digits.slice(-scale);
  return (negative ? '-' : '') + rendered;
}

export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const scale = Math.max(parts(left).fraction.length, parts(right).fraction.length);
  const difference = aligned(left, scale) - aligned(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function negateDecimalString(value: string): string {
  return value.startsWith('-') ? value.slice(1) : '-' + value;
}

export function sumSignedPostings(postings: readonly SignedPosting[]): { debit: string; credit: string } {
  const scale = postings.reduce((maximum, posting) =>
    Math.max(maximum, parts(posting.amount).fraction.length), 0);
  let debit = 0n;
  let credit = 0n;
  for (const posting of postings) {
    if (posting.direction === 'debit') debit += aligned(posting.amount, scale);
    else credit += aligned(posting.amount, scale);
  }
  return { debit: format(debit, scale), credit: format(credit, scale) };
}
