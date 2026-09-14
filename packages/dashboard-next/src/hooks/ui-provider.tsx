import { useEffect, useState, type ReactNode } from "react";
import {
  UIContext,
  THEME_KEY,
  ACCENT_KEY,
  resolveTheme,
  type Theme,
  type Accent,
} from "./ui-context";

export function UIProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [accent, setAccentState] = useState<Accent>("cortex");
  const [effective, setEffective] = useState<"light" | "dark">("dark");

  useEffect(() => {
    try {
      const t = (localStorage.getItem(THEME_KEY) as Theme | null) || "dark";
      const rawAccent = localStorage.getItem(ACCENT_KEY);
      const a = (rawAccent === "teal" ? "cyan" : rawAccent || "cortex") as Accent;
      setThemeState(t);
      setAccentState(a);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    const eff = resolveTheme(theme);
    setEffective(eff);
    const root = document.documentElement;
    root.classList.toggle("dark", eff === "dark");
    root.setAttribute("data-accent", accent);
    root.style.colorScheme = eff;
  }, [theme, accent]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* noop */
    }
  };
  const setAccent = (a: Accent) => {
    setAccentState(a);
    try {
      localStorage.setItem(ACCENT_KEY, a);
    } catch {
      /* noop */
    }
  };

  return (
    <UIContext.Provider value={{ theme, setTheme, effective, accent, setAccent }}>
      {children}
    </UIContext.Provider>
  );
}
