// The output format: one line of counts per input.

/**
 * Formats one input's counts as a line of plain text: lines, words and
 * characters, then the input's name when it has one.
 */
export function formatCounts(c, n) {
  const f = [c.lines, c.words, c.characters].map((x) => String(x).padStart(7));
  if (n !== undefined) f.push(n);
  return f.join(' ');
}
