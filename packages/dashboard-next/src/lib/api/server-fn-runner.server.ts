/**
 * server-fn-runner — the server-only bridge between `defineServerFn` (client-
 * reachable) and the security pipeline in `src/server/**` (WP-01).
 *
 * This is a `.server.ts` module: TanStack Start treats it as server-only, so a
 * client-reachable file may import it (the client gets a stripped proxy) and
 * import-protection does NOT flag its `src/server` imports. That is exactly
 * why the static import of the pipeline lives HERE, not in `define-server-fn.ts`
 * (whose non-handler code ships to the client and would trip the
 * "Denied by file pattern: src/server" import-protection rule).
 *
 * `runServerFnGate` runs inside the createServerFn server runtime: it reads the
 * live request via `getRequest()`, executes the proven `(Request) => Response`
 * pipeline, and either throws the typed-error `Response` verbatim (gate failure,
 * delivered by the RPC handler unchanged) or returns the handler DATA with the
 * pipeline's Set-Cookie + framework headers replayed onto the runtime response.
 */

import { getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";

import { defineApiRoute, type RouteOptions } from "@/server/server-fn-pipeline";

function applySetCookie(serialized: string): void {
  const parts = serialized.split(";").map((p) => p.trim());
  const first = parts.shift();
  if (!first) return;
  const eq = first.indexOf("=");
  if (eq < 0) return;
  const name = first.slice(0, eq);
  const value = decodeURIComponent(first.slice(eq + 1));

  const options: Record<string, unknown> = {};
  for (let i = 0; i < parts.length; i += 1) {
    const attr = parts[i];
    const [rawKey, rawVal] = attr.split("=");
    const key = (rawKey ?? "").toLowerCase();
    switch (key) {
      case "path":
        options.path = rawVal ?? "/";
        break;
      case "max-age":
        options.maxAge = Number(rawVal);
        break;
      case "httponly":
        options.httpOnly = true;
        break;
      case "secure":
        options.secure = true;
        break;
      case "samesite":
        options.sameSite = (rawVal ?? "lax").toLowerCase();
        break;
      default:
        break;
    }
  }
  setCookie(name, value, options);
}

export default async function runServerFnGate<TIn, TOut>(
  opts: RouteOptions<TIn, TOut>,
): Promise<TOut> {
  const request = getRequest();

  const core = defineApiRoute<TIn, TOut>(opts);
  const response = await core(request);

  // Gate FAILURE (non-2xx): hand the typed-error envelope back verbatim. The
  // server-functions handler returns a thrown `Response` unchanged (status +
  // body + headers preserved) — the runtime-correct way to deliver the HTTP
  // status + error body to the RPC client.
  if (response.status >= 400) {
    throw response;
  }

  // SUCCESS: replay the pipeline's Set-Cookie + framework security headers onto
  // the live runtime response, then return the handler DATA (idiomatic typed
  // RPC — the client receives the value, not a Response object).
  Array.from(response.headers.entries()).forEach(([name, value]) => {
    const lower = name.toLowerCase();
    if (lower === "set-cookie") {
      applySetCookie(value);
    } else if (lower !== "content-type" && lower !== "content-length") {
      // Framework security headers (X-Frame-Options, etc.). Skip transport
      // headers the RPC layer manages itself.
      setResponseHeader(name, value);
    }
  });

  const text = await response.text();
  return text ? (JSON.parse(text) as TOut) : (null as TOut);
}

/**
 * Re-emit a serialized `Set-Cookie` string through the runtime `setCookie`
 * helper so the framework owns the response's cookie state. Parses the subset
 * of attributes the pipeline emits (Path, Max-Age, HttpOnly, SameSite, Secure).
 */
