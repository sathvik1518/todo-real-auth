import type { Todo } from "../types";

// The server's names: { done, created_at }. The screen's names: { completed, createdAt }.
// This file is the ONLY place that knows both. If the server renames a field, one file changes.
export interface ServerTodo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

export interface ServerTodoPatch {
  title?: string;
  done?: boolean;
}

export function toTodo(server: ServerTodo): Todo {
  return { id: server.id, title: server.title, completed: server.done, createdAt: new Date(server.created_at) };
}

/** Only what was given. An undefined field is left out, so PATCH changes nothing else. */
export function toServerPatch(changes: { title?: string; completed?: boolean }): ServerTodoPatch {
  const patch: ServerTodoPatch = {};
  if (changes.title !== undefined) patch.title = changes.title;
  if (changes.completed !== undefined) patch.done = changes.completed;
  return patch;
}
