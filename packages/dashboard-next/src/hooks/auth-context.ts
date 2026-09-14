import { createContext } from "react";

export interface AuthUser {
  username: string;
  is_admin: boolean;
}

interface AuthCtx {
  user: AuthUser | null;
  /** True until the initial `me()` session probe resolves. */
  loading: boolean;
  login: (u: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthCtx | null>(null);
