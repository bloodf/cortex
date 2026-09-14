import { Link, useRouterState } from "@tanstack/react-router";
import { MOBILE_TABS } from "./NavConfig";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";

export function MobileTabBar() {
  const t = useT();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 md:hidden bg-background/95 backdrop-blur border-t flex">
      {MOBILE_TABS.map((it) => {
        const active = path === it.to;
        return (
          <Link
            key={it.to}
            to={it.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px]",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <it.icon className="size-5" />
            <span>{t.nav[it.key]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
