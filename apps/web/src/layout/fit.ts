// Menu overflow arithmetic (web-client-pixel-match R11.4). Pure.

/**
 * How many leading items fit in `containerWidth` after `reserve` px are kept for other parts.
 * When not all items fit, `overflowWidth` more px are kept for the `»` button.
 * Never negative, never more than the number of items.
 */
export function fitCount(
  containerWidth: number,
  itemWidths: readonly number[],
  reserve: number,
  overflowWidth: number,
): number {
  const total = itemWidths.reduce((a, b) => a + b, 0);
  if (total + reserve <= containerWidth) return itemWidths.length;
  const room = containerWidth - reserve - overflowWidth;
  let used = 0;
  let count = 0;
  for (const w of itemWidths) {
    if (used + w > room) break;
    used += w;
    count += 1;
  }
  return count;
}
