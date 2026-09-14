/**
 * RFC8785-style JSON Canonicalization Scheme (JCS).
 *
 * Stable key ordering by lexicographic UTF-16 code unit (the order
 * `Array.prototype.sort` gives for strings without a comparator). Matches
 * the helper used by the dashboard audit package so
 * hash-chain inputs are byte-identical regardless of which process appends.
 *
 * NOTE: matches the project convention rather than the strictest RFC8785
 * number serialisation — payloads going through this layer originate from
 * CloudEvents envelopes which never carry NaN / +Inf / -Inf values, so
 * `JSON.stringify` is safe for primitive serialization here.
 *
 * @param {unknown} value
 * @returns {string}
 */
export default function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
}
