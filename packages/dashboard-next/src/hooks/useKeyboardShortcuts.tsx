import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUI } from "@/hooks/useUI";

/**
 * Global keyboard shortcuts:
 *   ?       → opens shortcuts overlay (via callback)
 *   g+o     → /overview      g+a → /apps      g+d → /docker
 *   g+i     → /incus         g+t → /terminal  g+h → /healthcheck
 *   ⌘/ ctrl+/ → toggle dark/light
 *   ⌘b ctrl+b → toggle sidebar (via callback)
 */
export function useKeyboardShortcuts(opts: {
  onHelp: () => void;
  onToggleSidebar: () => void;
  onPalette: () => void;
}) {
  const navigate = useNavigate();
  const { theme, setTheme } = useUI();
  const lastG = useRef<number>(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inField =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as HTMLElement | null)?.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;

      // Palette
      if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        opts.onPalette();
        return;
      }
      // Theme toggle
      if (mod && e.key === "/") {
        e.preventDefault();
        setTheme(theme === "dark" ? "light" : "dark");
        return;
      }
      // Sidebar toggle
      if (mod && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        opts.onToggleSidebar();
        return;
      }

      if (inField) return;
      // Help
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        opts.onHelp();
        return;
      }
      // g-sequence
      if (e.key === "g" || e.key === "G") {
        lastG.current = Date.now();
        return;
      }
      if (Date.now() - lastG.current < 1200) {
        const map: Record<string, string> = {
          o: "/overview",
          a: "/apps",
          d: "/docker",
          i: "/incus",
          t: "/terminal",
          h: "/healthcheck",
          s: "/systemd",
          n: "/network",
        };
        const dest = map[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          lastG.current = 0;
          navigate({ to: dest });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, theme, setTheme, opts]);
}
