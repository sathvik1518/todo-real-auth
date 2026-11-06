import { describe, expect, it } from "vitest";
import { buildUrl, DEFAULT_TIMEOUT_MS, request } from "./client";
import { NetworkError, ServerError } from "./errors";
import { BASE, http, HttpResponse, requests, server } from "../test/server";

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
};

describe("buildUrl", () => {
  it("joins base and path", () => {
    expect(buildUrl("/api", "/todos")).toBe("/api/todos");
  });
  it("adds a query string", () => {
    expect(buildUrl("/api", "/todos", { done: true, q: "milk" })).toBe("/api/todos?done=true&q=milk");
  });
  it("leaves out undefined values and an empty query", () => {
    expect(buildUrl("/api", "/todos", { q: undefined })).toBe("/api/todos");
    expect(buildUrl("/api", "/todos")).toBe("/api/todos");
  });
  it("encodes & = spaces and # so they cannot split or end the query", () => {
    const url = buildUrl("/api", "/todos", { q: "a & b=c #1" });
    expect(url).toBe("/api/todos?q=a+%26+b%3Dc+%231");
    expect(new URL(url, "http://x").searchParams.get("q")).toBe("a & b=c #1");
  });
  it("keeps a non-English search intact", () => {
    expect(new URL(buildUrl("/api", "/todos", { q: "పాలు" }), "http://x").searchParams.get("q")).toBe("పాలు");
  });
});

describe("request: success", () => {
  it("returns the parsed JSON", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ a: 1 })));
    expect(await request("/thing")).toEqual({ a: 1 });
  });
  it("sends no content type on a GET", async () => {
    let seen: string | null = "unset";
    server.use(http.get(`${BASE}/thing`, ({ request }) => ((seen = request.headers.get("content-type")), HttpResponse.json({}))));
    await request("/thing");
    expect(seen).toBeNull();
  });
  it("sends JSON and a content type on a POST or PATCH", async () => {
    const seen: Array<{ method: string; type: string | null; body: unknown }> = [];
    server.use(
      http.post(`${BASE}/thing`, async ({ request }) => (seen.push({ method: "POST", type: request.headers.get("content-type"), body: await request.json() }), HttpResponse.json({}))),
      http.patch(`${BASE}/thing`, async ({ request }) => (seen.push({ method: "PATCH", type: request.headers.get("content-type"), body: await request.json() }), HttpResponse.json({}))),
    );
    await request("/thing", { method: "POST", body: { x: 1 } });
    await request("/thing", { method: "PATCH", body: { y: 2 } });
    expect(seen).toEqual([
      { method: "POST", type: "application/json", body: { x: 1 } },
      { method: "PATCH", type: "application/json", body: { y: 2 } },
    ]);
  });
  it("a 204 returns undefined and does not try to read a body", async () => {
    server.use(http.delete(`${BASE}/thing`, () => new HttpResponse(null, { status: 204 })));
    expect(await request("/thing", { method: "DELETE" })).toBeUndefined();
  });
  it("a 201 is a success", async () => {
    server.use(http.post(`${BASE}/thing`, () => HttpResponse.json({ id: 1 }, { status: 201 })));
    expect(await request("/thing", { method: "POST", body: {} })).toEqual({ id: 1 });
  });
  it("puts the query in the request", async () => {
    server.use(http.get(`${BASE}/todos`, ({ request: r }) => (requests.push(`GET ${new URL(r.url).pathname}${new URL(r.url).search}`), HttpResponse.json([]))));
    await request("/todos", { query: { q: "a & b" } });
    expect(requests[0]).toBe("GET /api/todos?q=a+%26+b");
  });
});

describe("request: the server said no -> ServerError", () => {
  it.each([400, 404, 409, 422, 500, 503])("status %s", async (status) => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ detail: "nope" }, { status })));
    const error = await caught(request("/thing"));
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(status);
  });
  it("uses the server's reason when it is a string", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ detail: "No such to-do." }, { status: 404 })));
    expect(((await caught(request("/thing"))) as ServerError).message).toBe("No such to-do.");
  });
  it("turns FastAPI's 422 list into messages per field", async () => {
    server.use(
      http.post(`${BASE}/thing`, () =>
        HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty." }, { loc: ["body", "done"], msg: "Input should be a valid boolean" }] }, { status: 422 }),
      ),
    );
    const error = (await caught(request("/thing", { method: "POST", body: {} }))) as ServerError;
    expect(error.fieldErrors).toEqual({ title: "Title cannot be empty.", done: "Input should be a valid boolean" });
  });
  it("keeps the first message when a field has two", async () => {
    server.use(http.post(`${BASE}/thing`, () => HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "first" }, { loc: ["body", "title"], msg: "second" }] }, { status: 422 })));
    expect(((await caught(request("/thing", { method: "POST", body: {} }))) as ServerError).fieldErrors).toEqual({ title: "first" });
  });
  it("a non-JSON error page (a proxy's 502) still becomes a ServerError", async () => {
    server.use(http.get(`${BASE}/thing`, () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })));
    const error = (await caught(request("/thing"))) as ServerError;
    expect(error).toBeInstanceOf(ServerError);
    expect(error.message).toBe("Request failed (502).");
  });
  it("a 200 whose body is not JSON is a ServerError, not a crash", async () => {
    server.use(http.get(`${BASE}/thing`, () => new HttpResponse("not json", { status: 200 })));
    expect(await caught(request("/thing"))).toBeInstanceOf(ServerError);
  });
});

describe("request: no server -> NetworkError", () => {
  it("a network failure is unreachable", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.error()));
    const error = await caught(request("/thing"));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("unreachable");
  });
  it("it is NOT a ServerError (the two are different kinds)", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.error()));
    expect(await caught(request("/thing"))).not.toBeInstanceOf(ServerError);
  });
  it("a request that gets no answer in time is a timeout", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const error = await caught(request("/thing", { timeoutMs: 60 }));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("timeout");
  });
  it("the default timeout is 8 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });
});

describe("request: cancelling", () => {
  it("the caller's cancel is rethrown as it is (not a NetworkError)", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const controller = new AbortController();
    const pending = caught(request("/thing", { signal: controller.signal }));
    controller.abort();
    const error = (await pending) as Error;
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(NetworkError);
  });
  it("the timeout still works when the caller passes its own signal", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const controller = new AbortController(); // never cancelled
    const error = await caught(request("/thing", { signal: controller.signal, timeoutMs: 60 }));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("timeout");
  });
  it("a signal that was already cancelled stops it at once", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(((await caught(request("/todos", { signal: controller.signal }))) as Error).name).toBe("AbortError");
    expect(requests).toEqual([]);
  });
});
