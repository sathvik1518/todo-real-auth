import { describe, expect, it } from "vitest";
import { NetworkError, ServerError } from "./api/errors";
import { describeError } from "./messages";

describe("describeError", () => {
  it("no server: tells you to check it is running", () => {
    expect(describeError(new NetworkError("unreachable"))).toBe("Cannot reach the server. Check that it is running, then try again.");
  });
  it("too slow: a different message from no server", () => {
    expect(describeError(new NetworkError("timeout"))).toBe("The server took too long to answer. Try again in a moment.");
  });
  it("a 500: says the server had a problem and shows the status", () => {
    expect(describeError(new ServerError(500, "boom"))).toBe("The server had a problem (500). It is not your fault. Try again in a moment.");
    expect(describeError(new ServerError(501, "x"))).toContain("(501)");
  });
  it("a 502/503/504 means a proxy has nothing behind it: same sentence as no server", () => {
    for (const status of [502, 503, 504]) {
      expect(describeError(new ServerError(status, "x"))).toBe(describeError(new NetworkError("unreachable")));
    }
  });
  it("a 404: shows the server's own sentence", () => {
    expect(describeError(new ServerError(404, "No such to-do."))).toBe("No such to-do.");
  });
  it("sign-in answers (401, 403, 409) show the server's own sentence", () => {
    expect(describeError(new ServerError(401, "Wrong email or password."))).toBe("Wrong email or password.");
    expect(describeError(new ServerError(403, "Only an admin can do that."))).toBe("Only an admin can do that.");
    expect(describeError(new ServerError(409, "That email is already registered. Try signing in."))).toBe("That email is already registered. Try signing in.");
  });
  it("a 422: shows what each field said", () => {
    expect(describeError(new ServerError(422, "Request failed (422).", { title: "Title cannot be empty." }))).toBe("Title cannot be empty.");
    expect(describeError(new ServerError(422, "x", { title: "A.", done: "B." }))).toBe("A. B.");
  });
  it("a 422 with no field details still says something useful", () => {
    expect(describeError(new ServerError(422, "x"))).toBe("Please check what you typed.");
  });
  it("anything else gets a plain sentence (never a blank or '[object Object]')", () => {
    expect(describeError(new Error("weird"))).toBe("Something went wrong.");
    expect(describeError("text")).toBe("Something went wrong.");
    expect(describeError(undefined)).toBe("Something went wrong.");
  });
  it("the server-error and no-server messages are different", () => {
    expect(describeError(new ServerError(500, "x"))).not.toBe(describeError(new NetworkError("unreachable")));
  });
});
