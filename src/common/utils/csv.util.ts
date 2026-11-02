/**
 * CSV escaping shared by the compliance and reporting exports.
 *
 * Free-text fields (SAR narratives, rule names, …) contain commas, quotes and
 * newlines that would break row/column alignment, and a value beginning with
 * `=`, `+`, `-` or `@` is executed as a formula by spreadsheet software, so it
 * is prefixed with a single quote.
 */

/** Characters a spreadsheet treats as the start of a formula. */
export const FORMULA_PREFIXES = ['=', '+', '-', '@'];

/**
 * Neutralises leading formula characters (=, +, -, @) with a leading single quote
 * so spreadsheet software treats the cell as literal text.
 */
export function sanitizeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return raw.length > 0 && FORMULA_PREFIXES.includes(raw[0]) ? `'${raw}` : raw;
}

/** Quotes one CSV field, always, so embedded separators cannot shift a column. */
export function escapeCsvField(value: unknown): string {
  const neutralised = sanitizeCsvValue(value);
  return `"${neutralised.replace(/"/g, '""')}"`;
}

/** Joins fields into one escaped CSV row. */
export function toCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvField).join(',');
}
