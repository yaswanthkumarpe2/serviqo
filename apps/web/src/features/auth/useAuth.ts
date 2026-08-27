import { use } from "react";

import { AuthContext } from "./AuthContext";

import type { AuthContextValue } from "./AuthContext";

/** Reads the session. Throws when rendered outside AuthProvider, rather than reporting a false logged-out state. */
export function useAuth(): AuthContextValue {
  const context = use(AuthContext);

  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
