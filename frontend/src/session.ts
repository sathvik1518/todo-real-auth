/**
 * Who is signed in, and the access token. Plain TypeScript, no React, so it can be tested alone.
 *
 * The access token lives in a variable. Not in localStorage, not in sessionStorage: a script injected into the page could read those.
 * The refresh token is an HttpOnly cookie that JavaScript cannot read at all. After a page reload the variable is empty, so the page
 * asks /auth/refresh, and the cookie (sent by the browser on its own) gets a new access token.
 */
import { request, setAuthHooks } from "./api/client";
import { ServerError } from "./api/errors";

export interface User {
  id: number;
  email: string;
  role: "viewer" | "admin";
}
export interface SessionState {
  status: "loading" | "signedOut" | "signedIn";
  user: User | null;
  /** A sentence for the sign-in page, e.g. when the session ended while the person was using the app. */
  notice: string | null;
}
interface TokenReply {
  access_token: string;
  expires_in: number;
  user: User;
}

const LOADING: SessionState = { status: "loading", user: null, notice: null };
let token: string | null = null; // memory only
let state: SessionState = LOADING;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

function setState(next: SessionState) {
  state = next;
  listeners.forEach((listener) => listener());
}
function accept(reply: TokenReply) {
  token = reply.access_token;
  setState({ status: "signedIn", user: reply.user, notice: null });
}

export const getSession = () => state;
export const getAccessToken = () => token;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function renewNow(): Promise<string | null> {
  try {
    const reply = await request<TokenReply>("/auth/refresh", { method: "POST", auth: false });
    accept(reply);
    return reply.access_token;
  } catch (error) {
    if (error instanceof ServerError && error.status === 401) {
      // The refresh cookie is missing, used, or expired: the session is really over.
      const wasSignedIn = state.status === "signedIn";
      token = null;
      setState({ status: "signedOut", user: null, notice: wasSignedIn ? "Your session ended. Please sign in again." : null });
      return null;
    }
    throw error; // no server, a timeout, a 500: the session may still be fine, so do not sign anyone out
  }
}

/**
 * Get a new access token. If several requests hit an expired token at the same moment, they all wait for ONE refresh call.
 * (Each refresh token works only once, so two refresh calls at the same time would cancel each other.)
 */
export function renewToken(failedWith: string | null): Promise<string | null> {
  // Someone already renewed while this request was in flight: use the new token, do not refresh again.
  if (token && token !== failedWith) return Promise.resolve(token);
  inflight ??= renewNow().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** On page load: try the cookie. If it works the person is signed in without typing anything. */
export async function bootstrap(): Promise<void> {
  if (state.status !== "loading") return;
  try {
    await renewToken(null);
  } catch {
    setState({ status: "signedOut", user: null, notice: null }); // the server could not be reached: show the sign-in page
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  accept(await request<TokenReply>("/auth/signin", { method: "POST", body: { email, password }, auth: false }));
}
export async function signUp(email: string, password: string): Promise<void> {
  accept(await request<TokenReply>("/auth/signup", { method: "POST", body: { email, password }, auth: false }));
}
/** Always signs out on this screen, even if the server cannot be reached. Tells the server so it can cancel the refresh token. */
export async function signOut(): Promise<void> {
  try {
    await request<void>("/auth/signout", { method: "POST", auth: false });
  } catch {
    // The token variable is cleared below either way.
  }
  token = null;
  setState({ status: "signedOut", user: null, notice: null });
}

/** For tests only. */
export function resetSession(): void {
  token = null;
  inflight = null;
  state = LOADING;
  listeners.clear();
}

setAuthHooks({ getToken: () => token, renew: renewToken });
