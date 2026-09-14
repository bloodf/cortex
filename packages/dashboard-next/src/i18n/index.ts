import { en, type Dict } from "./en";

/**
 * The dashboard ships in English only. The `t.*` dictionary mechanism is kept
 * (so call sites stay untouched), but it always resolves to the English dict.
 */
export function getDict(): Dict {
  return en;
}
