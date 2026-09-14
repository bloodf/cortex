import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouteContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ThemeProvider as LobeThemeProvider, MotionProvider } from "@lobehub/ui";
import { motion } from "motion/react";
import appCss from "../styles.css?url";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import brandMark from "@/assets/cortexos-mark.svg";
import reportLovableError from "../lib/lovable-error-reporting";
import { UIProvider } from "../hooks/ui-provider";
import { useUI } from "../hooks/useUI";
import type { Accent } from "../hooks/ui-context";
import { AuthProvider } from "../hooks/auth-provider";

// Cortex accent tokens -> @lobehub/ui (antd-style) PrimaryColors. Keeps the
// lobe component palette in lockstep with the existing data-accent attribute.
const ACCENT_TO_PRIMARY: Record<Accent, string> = {
  cortex: "geekblue",
  cyan: "cyan",
  emerald: "green",
  amber: "gold",
};

// Bridges the app's useUI state into @lobehub/ui's ThemeProvider so lobe
// components and the legacy Tailwind surfaces share one source of truth
// (effective light/dark + accent). Must render INSIDE UIProvider.
function LobeThemeBridge({ children }: { children: ReactNode }) {
  const { effective, accent } = useUI();
  return (
    <MotionProvider motion={motion}>
      <LobeThemeProvider
        themeMode={effective}
        customTheme={{ primaryColor: ACCENT_TO_PRIMARY[accent] as never, neutralColor: "slate" }}
        customToken={() => ({
          borderRadius: 12,
          fontFamily: "var(--font-sans)",
          colorBgContainer: "var(--card)",
          colorBgElevated: "var(--card)",
          colorBgLayout: "var(--background)",
          colorText: "var(--foreground)",
          colorTextSecondary: "var(--muted-foreground)",
          colorBorder: "var(--border)",
          colorBorderSecondary: "var(--border)",
        })}
      >
        {children}
      </LobeThemeProvider>
    </MotionProvider>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">This route doesn't exist.</p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function ToasterMount() {
  const { effective } = useUI();
  return <Toaster theme={effective} richColors closeButton position="bottom-right" />;
}

function RootComponent() {
  const { queryClient } = useRouteContext({ from: "__root__" });
  return (
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <LobeThemeBridge>
          <AuthProvider>
            <Outlet />
            <ToasterMount />
          </AuthProvider>
        </LobeThemeBridge>
      </UIProvider>
    </QueryClientProvider>
  );
}

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }} data-accent="cortex">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Cortex — Infrastructure Control-Plane" },
      { name: "description", content: "Self-hosted control-plane for systemd, Docker and Incus." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: brandMark },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});
