const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function formatReadableUtcInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid UTC instant: ${value}`);

  const hour24 = date.getUTCHours();
  const hour12 = hour24 % 12 || 12;
  const hour = String(hour12).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const meridiem = hour24 < 12 ? 'AM' : 'PM';

  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}, at ${hour}:${minute} ${meridiem}`;
}
