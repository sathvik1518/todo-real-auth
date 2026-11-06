import { describe, expect, it, vi } from "vitest";
import { request } from "./api/client";
import { NetworkError, ServerError } from "./api/errors";
import { deleteTodo, listTodos } from "./api/todos";
import { bootstrap, getAccessToken, getSession, renewToken, signIn, signOut } from "./session";
import { auth, BASE, expireToken, gate, http, HttpResponse, requests, seed, server } from "./test/server";

const GOOD = ["sam@example.com", "correct horse"] as const;

describe("signing in", () => {
  it("keeps the token in memory and knows who you are", async () => {
    await signIn(...GOOD);
    expect(getAccessToken()).toBe("token-1");
    expect(getSession()).toMatchObject({ status: "signedIn", user: { email: "sam@example.com", role: "viewer" } });
  });

  it("leaves NOTHING in localStorage, sessionStorage or document.cookie", async () => {
    await signIn(...GOOD);
    await listTodos();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("a wrong password is a 401 with the server's sentence, and does NOT start a refresh", async () => {
    const error = await signIn("sam@example.com", "wrong").catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Wrong email or password.");
    expect(auth.refreshCalls).toBe(0);
    expect(getSession().status).toBe("loading");
  });

  it("a wrong email gives exactly the same error as a wrong password", async () => {
    const wrongPassword = await signIn("sam@example.com", "wrong").catch((e) => e);
    const wrongEmail = await signIn("nobody@example.com", "correct horse").catch((e) => e);
    expect([wrongEmail.status, wrongEmail.message]).toEqual([wrongPassword.status, wrongPassword.message]);
  });
});

describe("the token is added to every call", () => {
  it("as a Bearer header", async () => {
    await signIn(...GOOD);
    await listTodos();
    expect(auth.lastAuthHeader).toBe("Bearer token-1");
  });

  it("the sign-in calls themselves carry no token", async () => {
    await signIn(...GOOD);
    let header: string | null = "unset";
    server.use(http.post(`${BASE}/auth/signin`, ({ request: r }) => ((header = r.headers.get("authorization")), HttpResponse.json({ detail: "x" }, { status: 401 }))));
    await signIn(...GOOD).catch(() => {});
    expect(header).toBeNull();
  });

  it("every call lets the cookie travel (credentials: include)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await signIn(...GOOD);
    await listTodos();
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(spy.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
    spy.mockRestore();
  });
});

describe("an expired token is renewed once, and the call is tried once more", () => {
  it("one call: refresh, retry with the new token, success", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    expireToken();
    const spy = vi.spyOn(globalThis, "fetch");
    const items = await listTodos();
    const listCalls = spy.mock.calls.filter(([url]) => String(url).includes("/todos")).length;
    spy.mockRestore();
    expect(items.map((t) => t.title)).toEqual(["Buy milk"]);
    expect(auth.refreshCalls).toBe(1);
    expect(auth.lastAuthHeader).toBe("Bearer token-2");
    expect(listCalls).toBe(2); // the failed try and the retry
  });

  it("THREE calls at the same moment make exactly ONE refresh call", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    auth.refreshDelayMs = 30; // slow enough that all three have hit the 401 before the first refresh is done
    expireToken();
    const results = await Promise.all([listTodos(), listTodos(), listTodos()]);
    expect(results.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(auth.refreshCalls).toBe(1);
  });

  it("a call whose 401 arrives AFTER the renewal does not start a second refresh", async () => {
    await signIn(...GOOD);
    const slow = gate();
    let seen = 0;
    server.use(
      http.get(`${BASE}/todos`, async ({ request: r }) => {
        if (r.headers.get("authorization") === "Bearer token-1") {
          if (seen++ === 1) await slow.promise; // the second call is held back
          return HttpResponse.json({ detail: "Your session expired." }, { status: 401 });
        }
        return HttpResponse.json([]);
      }),
    );
    const first = listTodos();
    const second = listTodos();
    await first; // the first call refreshed and retried
    slow.open(); // now the second call's 401 comes in, late
    await second;
    expect(auth.refreshCalls).toBe(1);
  });

  it("a second 401 after the retry is an error. There is no loop", async () => {
    await signIn(...GOOD);
    let tries = 0;
    server.use(http.get(`${BASE}/todos`, () => (tries++, HttpResponse.json({ detail: "No." }, { status: 401 }))));
    const error = await listTodos().catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(401);
    expect(tries).toBe(2);
    expect(auth.refreshCalls).toBe(1);
  });

  it("if the refresh is refused, the person is signed out with a notice", async () => {
    await signIn(...GOOD);
    auth.refreshOk = false;
    expireToken();
    const error = await listTodos().catch((e) => e);
    expect(error.status).toBe(401);
    expect(getAccessToken()).toBeNull();
    expect(getSession()).toEqual({ status: "signedOut", user: null, notice: "Your session ended. Please sign in again." });
  });

  it("if the server cannot be reached during the refresh, the person stays signed in", async () => {
    await signIn(...GOOD);
    expireToken();
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.error()));
    const error = await listTodos().catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(getSession().status).toBe("signedIn");
  });

  it("a refresh that fails with a 500 does not sign anyone out", async () => {
    await signIn(...GOOD);
    expireToken();
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ detail: "boom" }, { status: 500 })));
    const error = await listTodos().catch((e) => e);
    expect(error.status).toBe(500);
    expect(getSession().status).toBe("signedIn");
  });

  it("calls to /auth never trigger a refresh of their own", async () => {
    await signOut();
    expect(auth.refreshCalls).toBe(0);
  });

  it("renewToken called twice at once shares one refresh call", async () => {
    auth.refreshOk = true;
    auth.refreshDelayMs = 20;
    const [a, b] = await Promise.all([renewToken(null), renewToken(null)]);
    expect(a).toBe(b);
    expect(auth.refreshCalls).toBe(1);
  });
});

describe("the page loads: try the cookie", () => {
  it("a working cookie signs you in with no password", async () => {
    auth.refreshOk = true;
    await bootstrap();
    expect(getSession().status).toBe("signedIn");
    expect(requests).toEqual(["POST /api/auth/refresh"]);
  });

  it("no cookie means signed out, with no notice (nothing ended)", async () => {
    await bootstrap();
    expect(getSession()).toEqual({ status: "signedOut", user: null, notice: null });
  });

  it("no server means signed out so the sign-in page shows", async () => {
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.error()));
    await bootstrap();
    expect(getSession().status).toBe("signedOut");
  });
});

describe("signing out", () => {
  it("tells the server, forgets the token and the person", async () => {
    await signIn(...GOOD);
    await signOut();
    expect(auth.signoutCalls).toBe(1);
    expect(getAccessToken()).toBeNull();
    expect(getSession().status).toBe("signedOut");
  });

  it("still signs out on this screen when the server cannot be reached", async () => {
    await signIn(...GOOD);
    server.use(http.post(`${BASE}/auth/signout`, () => HttpResponse.error()));
    await signOut();
    expect(getAccessToken()).toBeNull();
    expect(getSession().status).toBe("signedOut");
  });
});

describe("a viewer who sends DELETE", () => {
  it("gets a 403 with the server's sentence", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    const error = await deleteTodo(1).catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(403);
    expect(error.message).toBe("Only an admin can do that.");
  });

  it("and a 403 does NOT trigger a refresh (that is for 401 only)", async () => {
    await signIn(...GOOD);
    await deleteTodo(1).catch(() => {});
    expect(auth.refreshCalls).toBe(0);
  });

  it("an admin can", async () => {
    auth.role = "admin";
    await signIn(...GOOD);
    seed("Buy milk");
    await expect(deleteTodo(1)).resolves.toBeUndefined();
  });
});
