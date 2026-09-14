import { createContext } from "react";

export type Theme = "light" | "dark" | "system";
export type Accent = "cortex" | "cyan" | "emerald" | "amber";

export interface UICtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  effective: "light" | "dark";
  accent: Accent;
  setAccent: (a: Accent) => void;
}

export const UIContext = createContext<UICtx | null>(null);
export const THEME_KEY = "cortex.theme";
export const ACCENT_KEY = "cortex.accent";

export function resolveTheme(t: Theme): "light" | "dark" {
  if (t !== "system") return t;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
