import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const BASE = "http://localhost:8000/api";

export interface FakeTodo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

/** The fake sign-in server. Tests change these fields to set the scene. */
export const auth = {
  validTokens: new Set<string>(), // access tokens the fake to-do routes accept
  refreshOk: false, // does the refresh cookie still work?
  refreshCalls: 0,
  refreshDelayMs: 0,
  signoutCalls: 0,
  role: "viewer" as "viewer" | "admin",
  email: "sam@example.com",
  counter: 0,
  lastAuthHeader: null as string | null,
};
const issue = () => {
  const token = `token-${++auth.counter}`;
  auth.validTokens = new Set([token]); // a new token replaces the old one, as if the old one had expired
  return { access_token: token, token_type: "bearer", expires_in: 300, user: { id: 1, email: auth.email, role: auth.role } };
};
/** Pretend the access token has run out. The next to-do request gets a 401. */
export const expireToken = () => (auth.validTokens = new Set());
const needLogin = (request: Request) => {
  auth.lastAuthHeader = request.headers.get("authorization");
  const token = auth.lastAuthHeader?.replace(/^Bearer /, "");
  return token && auth.validTokens.has(token) ? null : HttpResponse.json({ detail: "Your session expired." }, { status: 401 });
};

export let todos: FakeTodo[] = [];
export const requests: string[] = []; // e.g. "GET /api/todos?q=milk" or "PATCH /api/todos/2"
export let lastBody: unknown = undefined;
let nextId = 1;

export const seed = (...titles: string[]) => {
  titles.forEach((title) => todos.push({ id: nextId++, title, done: false, created_at: "2026-11-06T10:00:00Z" }));
};
export const resetServer = () => {
  auth.validTokens = new Set();
  auth.refreshOk = false;
  auth.refreshCalls = 0;
  auth.refreshDelayMs = 0;
  auth.signoutCalls = 0;
  auth.role = "viewer";
  auth.email = "sam@example.com";
  auth.counter = 0;
  auth.lastAuthHeader = null;
  todos = [];
  nextId = 1;
  requests.length = 0;
  lastBody = undefined;
};

/** Holds an answer back until open() is called. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export const handlers = [
  http.get(`${BASE}/todos`, ({ request }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    const url = new URL(request.url);
    requests.push(`GET ${url.pathname}${url.search}`);
    const q = url.searchParams.get("q")?.toLowerCase();
    const done = url.searchParams.get("done");
    const items = todos.filter((t) => (!q || t.title.toLowerCase().includes(q)) && (done === null || t.done === (done === "true")));
    return HttpResponse.json(items);
  }),
  http.post(`${BASE}/todos`, async ({ request }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    lastBody = await request.json();
    requests.push("POST /api/todos");
    const title = String((lastBody as { title?: string }).title ?? "").trim();
    if (!title) {
      return HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty.", type: "value_error" }] }, { status: 422 });
    }
    const todo: FakeTodo = { id: nextId++, title, done: false, created_at: "2026-11-06T10:00:00Z" };
    todos.push(todo);
    return HttpResponse.json(todo, { status: 201, headers: { Location: `/api/todos/${todo.id}` } });
  }),
  http.patch(`${BASE}/todos/:id`, async ({ request, params }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    lastBody = await request.json();
    requests.push(`PATCH /api/todos/${params.id}`);
    const todo = todos.find((t) => t.id === Number(params.id));
    if (!todo) return HttpResponse.json({ detail: "No such to-do." }, { status: 404 });
    Object.assign(todo, lastBody);
    return HttpResponse.json(todo);
  }),
  http.delete(`${BASE}/todos/:id`, ({ request, params }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    if (auth.role !== "admin") return HttpResponse.json({ detail: "Only an admin can do that." }, { status: 403 });
    requests.push(`DELETE /api/todos/${params.id}`);
    const index = todos.findIndex((t) => t.id === Number(params.id));
    if (index === -1) return HttpResponse.json({ detail: "No such to-do." }, { status: 404 });
    todos.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${BASE}/auth/signin`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    requests.push("POST /api/auth/signin");
    if (body.email === "sam@example.com" && body.password === "correct horse") {
      auth.refreshOk = true;
      return HttpResponse.json(issue());
    }
    return HttpResponse.json({ detail: "Wrong email or password." }, { status: 401 }); // the same for a wrong email and a wrong password
  }),
  http.post(`${BASE}/auth/signup`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    requests.push("POST /api/auth/signup");
    if (body.email === "taken@example.com") return HttpResponse.json({ detail: "That email is already registered. Try signing in." }, { status: 409 });
    if (body.password.length < 8) {
      return HttpResponse.json({ detail: [{ loc: ["body", "password"], msg: "String should have at least 8 characters", type: "string_too_short" }] }, { status: 422 });
    }
    auth.email = body.email;
    auth.refreshOk = true;
    return HttpResponse.json(issue(), { status: 201 });
  }),
  http.post(`${BASE}/auth/refresh`, async () => {
    auth.refreshCalls++;
    requests.push("POST /api/auth/refresh");
    if (auth.refreshDelayMs) await new Promise((r) => setTimeout(r, auth.refreshDelayMs));
    if (!auth.refreshOk) return HttpResponse.json({ detail: "Not signed in." }, { status: 401 });
    return HttpResponse.json(issue());
  }),
  http.post(`${BASE}/auth/signout`, () => {
    auth.signoutCalls++;
    requests.push("POST /api/auth/signout");
    auth.refreshOk = false;
    return new HttpResponse(null, { status: 204 });
  }),
];

export const server = setupServer(...handlers);
export { http, HttpResponse };
