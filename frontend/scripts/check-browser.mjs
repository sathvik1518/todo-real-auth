// Real-browser proof for sign-in. Starts the real FastAPI backend and the real Vite dev server, drives Chromium, and measures the four
// things that matter. The backend runs with a 3 second access token so "expired" happens fast.
//
// Run:  npm run proof      (needs: backend dependencies installed, and  npx playwright install chromium)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const backendDir = path.resolve(root, "..", "backend");
const shots = path.join(root, "proof");
mkdirSync(shots, { recursive: true });
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const work = mkdtempSync(path.join(tmpdir(), "todo-auth-proof-"));
const logFile = path.join(work, "backend.log");
const ADMIN = "admin@example.com";
const PASSWORD = "correct horse battery";
const numbers = {};

const children = [];
const results = [];
let failed = 0;
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isApi = (url) => new URL(url).pathname.startsWith("/api/"); // not "/src/api/..." source files

async function waitFor(url, what) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`${what} did not start (${url})`);
}
function startBackend(dbName) {
  writeFileSync(logFile, "");
  const p = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", "8000"], {
    cwd: backendDir,
    env: {
      ...process.env,
      TODO_DB: path.join(work, dbName),
      JWT_SECRET: "proof-secret-that-is-long-enough-0123456789abcdef",
      ACCESS_TTL_SECONDS: "3", // a very short token life while testing
      ADMIN_EMAILS: ADMIN,
    },
  });
  const append = (d) => writeFileSync(logFile, readFileSync(logFile) + d.toString());
  p.stdout.on("data", append);
  p.stderr.on("data", append);
  children.push(p);
  return p;
}
function startVite(mode) {
  const args = [path.join(root, "node_modules", "vite", "bin", "vite.js")];
  if (mode) args.push("--mode", mode);
  const p = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "ignore" });
  children.push(p);
  return p;
}
const stop = (p) => new Promise((resolve) => (p.exitCode !== null ? resolve() : (p.once("exit", resolve), p.kill())));
/** Lines the BACKEND logged, e.g. 'POST /api/auth/refresh HTTP/1.1" 200'. */
const logLines = () => readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('HTTP/1.1"'));
const count = (pattern) => logLines().filter((l) => pattern.test(l)).length;

async function api(base, method, route, { token, body, cookie } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 700, height: 560 } });
  const page = await context.newPage();
  const sent = [];
  page.on("request", async (r) => isApi(r.url()) && sent.push({ method: r.method(), url: new URL(r.url()), headers: await r.allHeaders() }));
  return { context, page, sent };
}
async function uiSignUp(page, base, email) {
  await page.goto(`${base}/signup`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("who").waitFor();
}
async function uiSignIn(page, base, email, password = PASSWORD) {
  await page.goto(`${base}/signin`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
/** Three list calls at the same moment, through the app's own API layer, after the 3 second token has expired. */
async function threeCallsOnAnExpiredToken(page, sent) {
  await page.waitForTimeout(4500); // access token life is 3 seconds
  const refreshBefore = count(/POST \/api\/auth\/refresh HTTP\/1.1" 200/);
  const eventsBefore = sent.filter((s) => s.url.pathname === "/api/auth/refresh").length;
  const lengths = await page.evaluate(async () => {
    const todos = await import("/src/api/todos.ts");
    const all = await Promise.all([todos.listTodos(), todos.listTodos(), todos.listTodos()]);
    return all.map((x) => x.length);
  });
  return {
    lengths,
    logged: count(/POST \/api\/auth\/refresh HTTP\/1.1" 200/) - refreshBefore,
    events: sent.filter((s) => s.url.pathname === "/api/auth/refresh").length - eventsBefore,
  };
}
async function storageReport(page, secret) {
  return page.evaluate(async (token) => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    const all = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]);
    return {
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length,
      documentCookie: document.cookie,
      indexedDB: dbs.length,
      tokenAnywhere: token ? all.includes(token) : null,
    };
  }, secret);
}

let browser;
try {
  browser = await chromium.launch();

  // ============================================================== MODE 1: DEV PROXY
  console.log("\n== Mode 1: dev proxy (npm run dev). Same address for page and API. ==");
  let backend = startBackend("proxy.db");
  let vite = startVite(undefined);
  await waitFor("http://localhost:8000/docs", "backend");
  await waitFor("http://localhost:5173/", "vite");
  const base = "http://localhost:5173";
  {
    // an admin (made by the server because of ADMIN_EMAILS) puts three to-dos in the list
    const admin = await api(`${base}/api`, "POST", "/auth/signup", { body: { email: ADMIN, password: PASSWORD } });
    check("the server made the admin from its own list (201, role admin)", admin.status === 201 && admin.json.user.role === "admin");
    for (const title of ["Buy milk", "Call mum", "Pay rent"]) await api(`${base}/api`, "POST", "/todos", { token: admin.json.access_token, body: { title } });

    const { context, page, sent } = await newPage(browser);
    await uiSignUp(page, base, "viewer@example.com");
    await page.getByText("Buy milk").waitFor();
    check("a new sign-up is a viewer, and sees the list", (await page.getByTestId("who").innerText()).includes("(viewer)"));
    check("a viewer sees no Delete buttons", (await page.getByRole("button", { name: /^Delete/ }).count()) === 0);
    await page.screenshot({ path: path.join(shots, "1-viewer.png") });

    // ---- NUMBER 2: the cookie's flags, as the browser stored them
    const cookie = (await context.cookies()).find((c) => c.name === "refresh_token");
    const days = cookie ? (cookie.expires - Date.now() / 1000) / 86400 : 0;
    numbers.cookie = cookie && { name: cookie.name, httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite, secure: cookie.secure, expiresInDays: Number(days.toFixed(2)) };
    console.log("      stored cookie:", JSON.stringify(numbers.cookie));
    check("cookie: HttpOnly", cookie?.httpOnly === true);
    check("cookie: Path is /api/auth (narrow)", cookie?.path === "/api/auth", cookie?.path);
    check("cookie: SameSite is Strict (explicit)", cookie?.sameSite === "Strict", cookie?.sameSite);
    check("cookie: Secure is off on plain http://localhost (it is on in production)", cookie?.secure === false);
    check("cookie lasts about 7 days", days > 6.9 && days < 7.1, `${days.toFixed(2)} days`);

    // ---- NUMBER 4: what is in storage and document.cookie
    const token = await page.evaluate(async () => (await import("/src/session.ts")).getAccessToken());
    const store = await storageReport(page, token);
    numbers.storage = store;
    console.log("      storage:", JSON.stringify({ ...store, tokenAnywhere: store.tokenAnywhere }));
    check("localStorage is empty (0 items)", store.localStorage === 0);
    check("sessionStorage is empty (0 items)", store.sessionStorage === 0);
    check("document.cookie is empty: JavaScript cannot see the refresh cookie", store.documentCookie === "", JSON.stringify(store.documentCookie));
    check("the access token is not in storage or document.cookie", store.tokenAnywhere === false);
    check("no IndexedDB databases", store.indexedDB === 0);
    check("the access token exists, in a variable", typeof token === "string" && token.split(".").length === 3);

    // the cookie travels only to /api/auth
    const todoCall = sent.find((s) => s.method === "GET" && s.url.pathname === "/api/todos");
    check("the cookie is NOT sent with a to-do request", todoCall && !("cookie" in todoCall.headers));
    check("the to-do request carries the Bearer token instead", todoCall?.headers.authorization?.startsWith("Bearer "));

    // a reload empties the variable. The cookie signs the person in again
    await page.reload();
    await page.getByTestId("who").waitFor();
    const refreshCall = sent.filter((s) => s.url.pathname === "/api/auth/refresh").at(-1);
    check("after a reload the person is still signed in (cookie -> refresh)", true);
    check("the refresh call carried the cookie", refreshCall && String(refreshCall.headers.cookie).includes("refresh_token="));

    // ---- NUMBER 1: three requests meet an expired token
    const three = await threeCallsOnAnExpiredToken(page, sent);
    numbers.threeRequestsOnExpiredToken = { refreshCallsInBackendLog: three.logged, refreshRequestsSeenByBrowser: three.events, allThreeSucceeded: three.lengths };
    console.log(`      3 requests on an expired token -> refresh calls: backend log ${three.logged}, browser ${three.events}; results ${three.lengths}`);
    check("three requests on an expired token: all three succeed", three.lengths.length === 3 && three.lengths.every((n) => n === 3), three.lengths.join());
    check("three requests on an expired token: exactly 1 refresh call (backend log)", three.logged === 1, `${three.logged}`);
    check("three requests on an expired token: exactly 1 refresh call (browser)", three.events === 1, `${three.events}`);

    // ---- NUMBER 3: a viewer sends DELETE by hand
    const viewerToken = await page.evaluate(async () => (await import("/src/session.ts")).getAccessToken());
    const del = await page.evaluate(async (t) => (await fetch("/api/todos/1", { method: "DELETE", headers: { Authorization: `Bearer ${t}` } })).status, viewerToken);
    const delBody = await page.evaluate(async (t) => (await (await fetch("/api/todos/1", { method: "DELETE", headers: { Authorization: `Bearer ${t}` } })).json()).detail, viewerToken);
    const delNone = await page.evaluate(async () => (await fetch("/api/todos/1", { method: "DELETE" })).status);
    const stillThere = await api(`${base}/api`, "GET", "/todos/1", { token: viewerToken });
    const adminNow = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: ADMIN, password: PASSWORD } }); // a fresh token: the first one is 3 seconds old by now
    const adminDelete = await api(`${base}/api`, "DELETE", "/todos/3", { token: adminNow.json.access_token });
    numbers.deleteByHand = { viewer: del, noToken: delNone, admin: adminDelete.status };
    console.log(`      DELETE by hand -> viewer ${del}, no token ${delNone}, admin ${adminDelete.status}`);
    check("a viewer's DELETE by hand: 403", del === 403, `${del}`);
    check("the 403 says why", delBody === "Only an admin can do that.", delBody);
    check("DELETE with no token: 401", delNone === 401, `${delNone}`);
    check("the refused delete changed nothing", stillThere.status === 200);
    check("an admin's DELETE: 204", adminDelete.status === 204, `${adminDelete.status}`);

    // the admin sees Delete buttons
    const adminCtx = await newPage(browser);
    await uiSignIn(adminCtx.page, base, ADMIN);
    await adminCtx.page.getByRole("button", { name: /^Delete/ }).first().waitFor();
    check("an admin sees Delete buttons", (await adminCtx.page.getByRole("button", { name: /^Delete/ }).count()) >= 1);
    await adminCtx.page.screenshot({ path: path.join(shots, "2-admin.png") });
    await adminCtx.context.close();

    // wrong email and wrong password look identical
    const wrong = await newPage(browser);
    await uiSignIn(wrong.page, base, "viewer@example.com", "not the password");
    const a = await wrong.page.getByRole("alert").innerText();
    await uiSignIn(wrong.page, base, "nobody@example.com", PASSWORD);
    const b = await wrong.page.getByRole("alert").innerText();
    const rawA = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: "viewer@example.com", password: "nope nope nope" } });
    const rawB = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: "nobody@example.com", password: "nope nope nope" } });
    check("wrong password and wrong email: the same sentence on screen", a === b && a === "Wrong email or password.", `${a} / ${b}`);
    check("wrong password and wrong email: the same status and body from the server", rawA.status === rawB.status && JSON.stringify(rawA.json) === JSON.stringify(rawB.json));
    await wrong.page.screenshot({ path: path.join(shots, "3-wrong-login.png") });
    await wrong.context.close();

    // sign out: cookie gone, and a copy of the old cookie is dead on the server
    const oldCookie = `refresh_token=${(await context.cookies()).find((c) => c.name === "refresh_token").value}`;
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    const after = (await context.cookies()).find((c) => c.name === "refresh_token");
    const replay = await api(`${base}/api`, "POST", "/auth/refresh", { cookie: oldCookie });
    check("sign out: the browser's cookie is gone", after === undefined);
    check("sign out: a copy of the old cookie no longer works (401)", replay.status === 401, `${replay.status}`);
    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    check("after sign out, the protected page sends you to sign in", true);
    await page.screenshot({ path: path.join(shots, "4-signed-out.png") });
    await context.close();
  }
  await stop(backend);
  await stop(vite);

  // ============================================================== MODE 2: CORS
  console.log("\n== Mode 2: cross-origin (npm run dev:cors). Page :5173, API :8000. The cookie must cross with credentials. ==");
  backend = startBackend("cors.db");
  vite = startVite("cors");
  await waitFor("http://localhost:8000/docs", "backend");
  await waitFor("http://localhost:5173/", "vite");
  {
    const admin = await api("http://localhost:8000/api", "POST", "/auth/signup", { body: { email: ADMIN, password: PASSWORD } });
    for (const title of ["Buy milk", "Call mum"]) await api("http://localhost:8000/api", "POST", "/todos", { token: admin.json.access_token, body: { title } });
    const { context, page, sent } = await newPage(browser);
    await uiSignUp(page, "http://localhost:5173", "viewer@example.com");
    await page.getByText("Buy milk").waitFor();
    check("cors mode: sign-up and the list work across origins", sent.every((s) => s.url.host === "localhost:8000"), [...new Set(sent.map((s) => s.url.host))].join());
    const cookie = (await context.cookies()).find((c) => c.name === "refresh_token");
    check("cors mode: the cookie was accepted from the other origin, with the same flags", cookie?.httpOnly && cookie.path === "/api/auth" && cookie.sameSite === "Strict", JSON.stringify(cookie && { httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite }));
    await page.reload();
    await page.getByTestId("who").waitFor();
    check("cors mode: after a reload the cookie signs the person in again (credentials: include works)", true);
    const three = await threeCallsOnAnExpiredToken(page, sent);
    check("cors mode: three requests on an expired token make exactly 1 refresh call", three.logged === 1 && three.events === 1 && three.lengths.every((n) => n === 2), `log ${three.logged}, browser ${three.events}`);
    const store = await storageReport(page, null);
    check("cors mode: storage and document.cookie are empty", store.localStorage === 0 && store.sessionStorage === 0 && store.documentCookie === "");
    const preflights = logLines().filter((l) => l.includes('"OPTIONS ')).map((l) => l.match(/"OPTIONS ([^ ]+)/)[1]);
    numbers.corsPreflightsSeenInBackendLog = [...new Set(preflights)];
    console.log("      preflights the backend saw (distinct addresses):", numbers.corsPreflightsSeenInBackendLog.join(" "));
    check("cors mode: the Authorization header made the browser preflight the to-do calls", preflights.includes("/api/todos"));
    await page.screenshot({ path: path.join(shots, "5-cors-mode.png") });
    await context.close();
  }
  await stop(vite);
} finally {
  for (const c of children) c.exitCode === null && c.kill();
  if (browser) await browser.close();
  writeFileSync(path.join(shots, "proof-numbers.json"), JSON.stringify(numbers, null, 2));
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots and numbers are in frontend/proof/`);
process.exit(failed ? 1 : 0);
