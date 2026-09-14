import type { ReactNode } from "react";
import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileTabBar } from "./MobileTabBar";
import { CommandPalette } from "./CommandPalette";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { DemoTour } from "@/components/DemoTour";
import { IncidentToaster } from "@/components/IncidentToaster";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useKeyboardShortcuts({
    onHelp: () => setHelpOpen(true),
    onToggleSidebar: () => setCollapsed((c) => !c),
    onPalette: () => setPaletteOpen(true),
  });

  return (
    <div className="min-h-dvh flex bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
      >
        Skip to main content
      </a>
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed(!collapsed)}
          onOpenMobile={() => setMobileOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
        <main
          id="main-content"
          className="flex-1 min-w-0 overflow-x-hidden pb-20 md:pb-0"
          tabIndex={-1}
        >
          <div
            key={pathname}
            className="px-4 sm:px-6 lg:px-8 py-5 max-w-[1600px] mx-auto w-full animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
          >
            {children}
          </div>
        </main>
        <MobileTabBar />
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenHelp={() => setHelpOpen(true)}
      />
      <KeyboardShortcuts open={helpOpen} onOpenChange={setHelpOpen} />
      <DemoTour />
      <IncidentToaster />
    </div>
  );
}
