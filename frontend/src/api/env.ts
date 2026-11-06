/**
 * Reads the API address from the environment and fails LOUDLY if it is missing.
 * A trailing slash is removed, so base + "/todos" never becomes "...//todos".
 */
export function readApiBase(env: { VITE_API_BASE_URL?: string }): string {
  const value = env.VITE_API_BASE_URL?.trim();
  if (!value) {
    throw new Error("VITE_API_BASE_URL is not set. Add it to .env.development (see .env.example).");
  }
  return value.replace(/\/+$/, "");
}

export const API_BASE = readApiBase(import.meta.env);
