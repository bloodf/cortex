import { useEffect, useState } from "react";

const KEY = "cortex.favorites";

export function useFavorites() {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    try {
      setFavs(JSON.parse(localStorage.getItem(KEY) || "[]"));
    } catch {
      /* noop */
    }
  }, []);
  const persist = (next: string[]) => {
    setFavs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
  };
  const isFavorite = (slug: string) => favs.includes(slug);
  return {
    favs,
    isFavorite,
    toggle: (slug: string) =>
      persist(favs.includes(slug) ? favs.filter((s) => s !== slug) : [...favs, slug]),
  };
}
