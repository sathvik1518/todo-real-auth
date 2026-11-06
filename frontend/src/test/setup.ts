import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetSession } from "../session";
import { resetServer, server } from "./server";

// React reports mistakes with console.error. Any console.error fails the test.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  const calls = errorSpy.mock.calls.map((c: unknown[]) => c.join(" "));
  errorSpy.mockRestore();
  expect(calls, "console.error was called during the test").toEqual([]);
});

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetServer();
  resetSession();
  localStorage.clear();
  sessionStorage.clear();
});
afterAll(() => server.close());
