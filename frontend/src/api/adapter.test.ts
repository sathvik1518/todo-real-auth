import { describe, expect, it } from "vitest";
import { toServerPatch, toTodo } from "./adapter";

describe("toTodo (server names to screen names)", () => {
  const server = { id: 3, title: "Buy milk", done: true, created_at: "2026-11-06T10:30:00Z" };
  it("renames done to completed", () => {
    expect(toTodo(server).completed).toBe(true);
    expect(toTodo(server)).not.toHaveProperty("done");
  });
  it("renames created_at to createdAt and makes it a real Date", () => {
    const todo = toTodo(server);
    expect(todo).not.toHaveProperty("created_at");
    expect(todo.createdAt).toBeInstanceOf(Date);
    expect(todo.createdAt.toISOString()).toBe("2026-11-06T10:30:00.000Z");
  });
  it("keeps id and title", () => {
    expect(toTodo(server)).toMatchObject({ id: 3, title: "Buy milk" });
  });
  it("false stays false", () => {
    expect(toTodo({ ...server, done: false }).completed).toBe(false);
  });
});

describe("toServerPatch (screen names to server names)", () => {
  it("completed becomes done", () => {
    expect(toServerPatch({ completed: true })).toEqual({ done: true });
  });
  it("false is sent (it is a real change, not 'nothing')", () => {
    expect(toServerPatch({ completed: false })).toEqual({ done: false });
  });
  it("only what was given is sent", () => {
    expect(toServerPatch({ title: "New" })).toEqual({ title: "New" });
    expect(toServerPatch({})).toEqual({});
  });
  it("an empty-string title is sent too (the server decides it is wrong)", () => {
    expect(toServerPatch({ title: "" })).toEqual({ title: "" });
  });
  it("both together", () => {
    expect(toServerPatch({ title: "New", completed: true })).toEqual({ title: "New", done: true });
  });
});
