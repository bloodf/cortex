import { createFileRoute, redirect, useRouter, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button, Input } from "@lobehub/ui";
import brandMark from "@/assets/cortexos-mark.svg";
import { FCard } from "@/components/fable";
import { useAuth } from "@/hooks/useAuth";
import { useT } from "@/hooks/useT";

interface LoginSearch {
  redirect?: string;
}

function LoginPage() {
  const { login, user } = useAuth();
  const t = useT();
  const router = useRouter();
  const search = useSearch({ from: "/login" });
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) {
    throw redirect({ to: search.redirect || "/overview" });
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(u, p);
      router.navigate({ to: search.redirect || "/overview" });
    } catch (caught: unknown) {
      const caughtErr = caught as { message?: string };
      setErr(caughtErr.message || t.auth.invalid);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden p-6 bg-background">
      <FCard className="w-96 max-w-full p-8">
        <form onSubmit={submit} className="space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <img src={brandMark} alt="" className="size-12" aria-hidden />
            <div>
              <h1 className="font-display text-xl font-semibold tracking-tight">{t.auth.signIn}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{t.app.tagline}</p>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="u" className="text-sm font-medium leading-none">
              {t.auth.username}
            </label>
            <Input
              id="u"
              value={u}
              onChange={(e) => setU(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="p" className="text-sm font-medium leading-none">
              {t.auth.password}
            </label>
            <div className="relative">
              <Input
                id="p"
                type={show ? "text" : "password"}
                value={p}
                onChange={(e) => setP(e.target.value)}
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={show ? t.auth.hide : t.auth.show}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <Button htmlType="submit" type="primary" block disabled={busy}>
            {busy ? "…" : t.auth.signIn}
          </Button>
        </form>
      </FCard>
      <footer className="mt-6 flex items-center gap-4 text-xs text-muted-foreground">
        <span>© Cortex</span>
      </footer>
    </div>
  );
}

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  component: LoginPage,
});
