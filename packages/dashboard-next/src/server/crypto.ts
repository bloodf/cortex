import { createHash } from "node:crypto";

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(x: string): string {
  return createHash("sha256").update(x).digest("hex");
}
