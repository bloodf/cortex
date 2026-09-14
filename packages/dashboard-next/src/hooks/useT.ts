import { getDict } from "@/i18n";

/** Returns the (English-only) translation dictionary. */
export function useT() {
  return getDict();
}
