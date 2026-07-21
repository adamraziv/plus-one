export function satisfiesRequestedGrain(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  const requestedGrain = new Set(requested);
  return requested.every((value) => actual.includes(value))
    && actual.every((value) => requestedGrain.has(value) || value === 'household');
}
