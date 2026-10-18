// BOM and NUL are transport/editor pollution, not whitespace or wording.
// Keep every other character (including qualifiers, punctuation and newlines).
export const modelEvidenceText = text => text.replace(/[\u0000\ufeff]/g, '');

export function locateEvidenceText(source, quote) {
  if (!modelEvidenceText(quote).trim()) return null;
  const exact = source.indexOf(quote);
  if (quote && exact >= 0) return { text: quote, start: exact, end: exact + quote.length };
  const cleanQuote = modelEvidenceText(quote);
  if (!cleanQuote) return null;
  const positions = [];
  let cleanSource = '';
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\u0000' || source[index] === '\ufeff') continue;
    positions.push(index);
    cleanSource += source[index];
  }
  let found = null;
  for (let index = cleanSource.indexOf(cleanQuote); index >= 0; index = cleanSource.indexOf(cleanQuote, index + 1)) {
    const start = positions[index], end = positions[index + cleanQuote.length - 1] + 1;
    const text = source.slice(start, end);
    // Repeated identical clauses are safe; differing raw clauses are ambiguous.
    if (found && found.text !== text) return null;
    found ??= { text, start, end };
  }
  return found;
}
