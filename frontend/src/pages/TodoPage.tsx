import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { createTodo, deleteTodo, listTodos, updateTodo } from "../api/todos";
import { describeError } from "../messages";
import type { Filter, Todo } from "../types";

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export default function TodoPage() {
  const { user, signOut } = useAuth();
  const isAdmin = user?.role === "admin"; // only decides what to SHOW. The server decides what is allowed (403).
  const [todos, setTodos] = useState<Todo[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Load the list again whenever the search, the filter or "Try again" changes.
  // The cleanup cancels the request that is still running, so an old answer cannot arrive late and overwrite a new one.
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    listTodos({ q: search.trim(), filter }, controller.signal)
      .then((items) => {
        setTodos(items);
        setLoad({ kind: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return; // we cancelled it ourselves: nothing to show
        setLoad({ kind: "error", message: describeError(error) });
      });
    return () => controller.abort();
  }, [search, filter, reloadKey]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    void run(async () => {
      const created = await createTodo(text);
      setTitle("");
      if (filter !== "completed" && (!search.trim() || created.title.toLowerCase().includes(search.trim().toLowerCase()))) {
        setTodos((current) => [...current, created]);
      }
    });
  }

  const toggle = (todo: Todo) =>
    run(async () => {
      const updated = await updateTodo(todo.id, { completed: !todo.completed });
      setTodos((current) => current.map((t) => (t.id === updated.id ? updated : t)));
    });

  const remove = (todo: Todo) =>
    run(async () => {
      await deleteTodo(todo.id);
      setTodos((current) => current.filter((t) => t.id !== todo.id));
    });

  return (
    <main>
      <header className="row">
        <h1>To-do</h1>
        <span className="muted" data-testid="who">
          {user?.email} ({user?.role})
        </span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <form className="row" onSubmit={onAdd}>
        <label htmlFor="new-todo" className="muted">
          New to-do
        </label>
        <input id="new-todo" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" disabled={busy}>
          Add
        </button>
      </form>

      <div className="row">
        <label htmlFor="search" className="muted">
          Search
        </label>
        <input id="search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label htmlFor="filter" className="muted">
          Show
        </label>
        <select id="filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {actionError && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}

      {load.kind === "loading" && <p role="status">Loading…</p>}
      {load.kind === "error" && (
        <div role="alert" className="error">
          <p>{load.message}</p>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      )}
      {load.kind === "ready" && todos.length === 0 && <p className="muted">Nothing here yet.</p>}
      {load.kind === "ready" && todos.length > 0 && (
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              <label>
                <input type="checkbox" checked={todo.completed} disabled={busy} onChange={() => toggle(todo)} />
                <span className={todo.completed ? "done" : undefined}>{todo.title}</span>
              </label>
              {isAdmin && (
                <button type="button" disabled={busy} aria-label={`Delete ${todo.title}`} onClick={() => remove(todo)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
