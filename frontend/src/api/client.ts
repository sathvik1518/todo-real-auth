import { API_BASE } from "./env";
import { NetworkError, ServerError } from "./errors";

export const DEFAULT_TIMEOUT_MS = 8000;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Becomes the query string. Undefined values are left out. Encoding is done for you. */
  query?: Record<string, string | boolean | undefined>;
  body?: unknown;
  /** The caller's own cancel signal (for example, when a component goes away). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Default true: add the access token, and if the server answers 401, renew it ONCE and try again. The /auth calls pass false. */
  auth?: boolean;
}

/** The sign-in code plugs itself in here. The API layer does not know how tokens are stored or renewed. */
export interface AuthHooks {
  getToken(): string | null;
  /** Called after a 401. `failedWith` is the token that was rejected. Resolves to a usable token, or null if the person is signed out. */
  renew(failedWith: string | null): Promise<string | null>;
}
let hooks: AuthHooks | null = null;
export function setAuthHooks(next: AuthHooks | null): void {
  hooks = next;
}

/** base + path + query string. URLSearchParams escapes "&", "=", spaces and the rest, so a search for "a & b" is safe. */
export function buildUrl(base: string, path: string, query: RequestOptions["query"] = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return `${base}${path}${text ? `?${text}` : ""}`;
}

/** FastAPI sends 422 as a list: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty." }] */
function readFieldErrors(detail: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!Array.isArray(detail)) return fields;
  for (const item of detail) {
    const loc = Array.isArray(item?.loc) ? item.loc : [];
    const field = String(loc[loc.length - 1] ?? "request");
    if (!(field in fields)) fields[field] = String(item?.msg ?? "Invalid value.").replace(/^Value error, /, "");
  }
  return fields;
}

async function toServerError(res: Response): Promise<ServerError> {
  let detail: unknown;
  try {
    detail = (await res.json()).detail;
  } catch {
    // the error body was not JSON (a proxy's error page, for example): use the generic message below
  }
  if (typeof detail === "string") return new ServerError(res.status, detail);
  const fieldErrors = readFieldErrors(detail);
  return new ServerError(res.status, `Request failed (${res.status}).`, fieldErrors);
}

/**
 * One attempt. Turns "no answer" into NetworkError, and lets a caller cancel pass through untouched.
 * A timeout is added to every attempt, and it still works when the caller passes its own signal.
 */
async function send(base: string, path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const { method = "GET", query, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = {};
  // A JSON content type is what makes a cross-origin POST or PATCH trigger a preflight. GET and DELETE send none.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    return await fetch(buildUrl(base, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // "include" lets the refresh cookie travel when the page and the API have different addresses (cors mode).
      credentials: "include",
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error; // the caller cancelled
    if (timeout.aborted) throw new NetworkError("timeout");
    throw new NetworkError("unreachable");
  }
}

/**
 * The ONE place that talks to the server.
 *   - 2xx with a body: the parsed JSON.   204: undefined (there is no body to parse).
 *   - the server said no:  throws ServerError (with the status).
 *   - no answer at all:    throws NetworkError ("unreachable" or "timeout").
 *   - the CALLER cancelled: the original abort error is rethrown, because that is not a failure to show.
 *   - a 401 on a signed-in call: the token is renewed ONCE and the call is tried ONCE more. A second 401 is an error.
 */
export async function request<T>(path: string, options: RequestOptions = {}, base: string = API_BASE): Promise<T> {
  const useAuth = options.auth !== false && hooks !== null;
  const firstToken = useAuth ? hooks!.getToken() : null;
  let res = await send(base, path, options, firstToken);

  if (res.status === 401 && useAuth) {
    const fresh = await hooks!.renew(firstToken);
    if (fresh) res = await send(base, path, options, fresh); // exactly one retry, never a loop
  }

  if (!res.ok) throw await toServerError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ServerError(res.status, "The server sent a reply the app could not read.");
  }
}
