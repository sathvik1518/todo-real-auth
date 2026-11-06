import type { Filter, Todo } from "../types";
import { type ServerTodo, toServerPatch, toTodo } from "./adapter";
import { request } from "./client";

// The contract, as functions. Nothing outside this file builds a URL.
export async function listTodos(params: { q?: string; filter?: Filter } = {}, signal?: AbortSignal): Promise<Todo[]> {
  const done = params.filter === "completed" ? true : params.filter === "active" ? false : undefined;
  const items = await request<ServerTodo[]>("/todos", { query: { q: params.q || undefined, done }, signal });
  return items.map(toTodo);
}

export async function createTodo(title: string): Promise<Todo> {
  return toTodo(await request<ServerTodo>("/todos", { method: "POST", body: { title } }));
}

export async function updateTodo(id: number, changes: { title?: string; completed?: boolean }): Promise<Todo> {
  return toTodo(await request<ServerTodo>(`/todos/${id}`, { method: "PATCH", body: toServerPatch(changes) }));
}

export async function deleteTodo(id: number): Promise<void> {
  await request<void>(`/todos/${id}`, { method: "DELETE" });
}
