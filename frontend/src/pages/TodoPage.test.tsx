import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { BASE, gate, http, HttpResponse, lastBody, requests, seed, server, todos } from "../test/server";

const list = () => screen.getByRole("list");
const items = () => within(list()).getAllByRole("listitem");

describe("loading the list", () => {
  it("shows a checking message, then the to-dos", async () => {
    seed("Buy milk", "Call mum");
    renderApp();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your session…"); // first the cookie is tried
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("Call mum")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when there is nothing", async () => {
    renderApp();
    expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("a 500 shows the SERVER message and Try again recovers", async () => {
    seed("Buy milk");
    server.use(http.get(`${BASE}/todos`, () => HttpResponse.json({ detail: "boom" }, { status: 500 }), { once: true }));
    renderApp();
    expect(await screen.findByText(/The server had a problem \(500\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Cannot reach the server/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("no server shows a DIFFERENT message from a server error", async () => {
    server.use(http.get(`${BASE}/todos`, () => HttpResponse.error()));
    renderApp();
    expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument();
    expect(screen.queryByText(/The server had a problem/)).not.toBeInTheDocument();
  });

  it("a 502 from the dev proxy (backend off) reads as no server, not as a server bug", async () => {
    server.use(http.get(`${BASE}/todos`, () => new HttpResponse("Bad Gateway", { status: 502 })));
    renderApp();
    expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument();
  });

  it("the page is not blank on an error (the heading and form are still there)", async () => {
    server.use(http.get(`${BASE}/todos`, () => HttpResponse.error()));
    renderApp();
    await screen.findByText(/Cannot reach the server/);
    expect(screen.getByRole("heading", { name: "To-do" })).toBeInTheDocument();
    expect(screen.getByLabelText("New to-do")).toBeInTheDocument();
  });
});

describe("adding", () => {
  it("201: the new to-do appears and the box is cleared", async () => {
    renderApp();
    await screen.findByText("Nothing here yet.");
    await userEvent.type(screen.getByLabelText("New to-do"), "Buy bread");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Buy bread")).toBeInTheDocument();
    expect(screen.getByLabelText("New to-do")).toHaveValue("");
    expect(todos).toHaveLength(1);
  });

  it("sends exactly { title } (the server forbids anything extra)", async () => {
    renderApp();
    await screen.findByText("Nothing here yet.");
    await userEvent.type(screen.getByLabelText("New to-do"), "  Buy bread  ");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("Buy bread");
    expect(lastBody).toEqual({ title: "Buy bread" });
  });

  it("an empty box sends nothing", async () => {
    renderApp();
    await screen.findByText("Nothing here yet.");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(requests.filter((r) => r.startsWith("POST /api/todos"))).toEqual([]);
  });

  it("a 422 from the server shows the server's field message and keeps what you typed", async () => {
    server.use(
      http.post(`${BASE}/todos`, () => HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty." }] }, { status: 422 })),
    );
    renderApp();
    await screen.findByText("Nothing here yet.");
    await userEvent.type(screen.getByLabelText("New to-do"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Title cannot be empty.");
    expect(screen.getByLabelText("New to-do")).toHaveValue("x");
  });

  it("no server while adding shows the no-server message", async () => {
    renderApp();
    await screen.findByText("Nothing here yet.");
    server.use(http.post(`${BASE}/todos`, () => HttpResponse.error()));
    await userEvent.type(screen.getByLabelText("New to-do"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server");
  });

  it("the Add button is disabled while the request runs (no double add)", async () => {
    renderApp();
    await screen.findByText("Nothing here yet.");
    const hold = gate();
    server.use(http.post(`${BASE}/todos`, async () => (await hold.promise, undefined)));
    await userEvent.type(screen.getByLabelText("New to-do"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    hold.open();
    await screen.findByText("x");
    expect(todos).toHaveLength(1);
  });
});

describe("toggling (PATCH)", () => {
  it("sends only { done } and shows the change", async () => {
    seed("Buy milk");
    renderApp();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Buy milk" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Buy milk" })).toBeChecked());
    expect(lastBody).toEqual({ done: true });
    expect(requests).toContain("PATCH /api/todos/1");
  });

  it("toggling again sends done: false", async () => {
    seed("Buy milk");
    renderApp();
    const box = await screen.findByRole("checkbox", { name: "Buy milk" });
    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(lastBody).toEqual({ done: false });
  });

  it("a 404 (deleted elsewhere) shows the server's sentence", async () => {
    seed("Buy milk");
    renderApp();
    const box = await screen.findByRole("checkbox", { name: "Buy milk" });
    todos.length = 0; // it vanishes on the server
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("No such to-do.");
    expect(box).not.toBeChecked(); // the screen did not pretend it worked
  });

  it("a 500 shows the server-problem message and the box is unchanged", async () => {
    seed("Buy milk");
    renderApp();
    const box = await screen.findByRole("checkbox", { name: "Buy milk" });
    server.use(http.patch(`${BASE}/todos/:id`, () => HttpResponse.json({ detail: "x" }, { status: 500 })));
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("The server had a problem (500)");
    expect(box).not.toBeChecked();
  });
});

describe("deleting", () => {
  it("204: the to-do disappears", async () => {
    seed("Buy milk", "Call mum");
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Buy milk" }));
    await waitFor(() => expect(screen.queryByText("Buy milk")).not.toBeInTheDocument());
    expect(items()).toHaveLength(1);
    expect(requests).toContain("DELETE /api/todos/1");
  });

  it("a 404 shows the server's sentence and keeps the row", async () => {
    seed("Buy milk");
    renderApp();
    const button = await screen.findByRole("button", { name: "Delete Buy milk" });
    todos.length = 0;
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("No such to-do.");
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
  });

  it("an error message goes away when the next action starts", async () => {
    seed("Buy milk", "Call mum");
    renderApp();
    const first = await screen.findByRole("button", { name: "Delete Buy milk" });
    server.use(http.delete(`${BASE}/todos/1`, () => HttpResponse.json({ detail: "x" }, { status: 500 }), { once: true }));
    await userEvent.click(first);
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Delete Call mum" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("search and filter", () => {
  it("search asks the server with q", async () => {
    seed("Buy milk", "Call mum");
    renderApp();
    await screen.findByText("Buy milk");
    await userEvent.type(screen.getByLabelText("Search"), "milk");
    await waitFor(() => expect(screen.queryByText("Call mum")).not.toBeInTheDocument());
    expect(requests.at(-1)).toBe("GET /api/todos?q=milk");
  });

  it("an & in the search is encoded, not split", async () => {
    seed("salt & pepper", "salt and pepper");
    renderApp();
    await screen.findByText("salt & pepper");
    await userEvent.type(screen.getByLabelText("Search"), "salt & pepper");
    await waitFor(() => expect(screen.queryByText("salt and pepper")).not.toBeInTheDocument());
    expect(requests.at(-1)).toBe("GET /api/todos?q=salt+%26+pepper");
  });

  it("the filter sends done=true or done=false", async () => {
    seed("Buy milk");
    renderApp();
    await screen.findByText("Buy milk");
    await userEvent.selectOptions(screen.getByLabelText("Show"), "completed");
    await waitFor(() => expect(requests.at(-1)).toBe("GET /api/todos?done=true"));
    await userEvent.selectOptions(screen.getByLabelText("Show"), "active");
    await waitFor(() => expect(requests.at(-1)).toBe("GET /api/todos?done=false"));
    await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
    await waitFor(() => expect(requests.at(-1)).toBe("GET /api/todos"));
  });

  it("an old answer that arrives late cannot overwrite a newer one", async () => {
    seed("Buy milk", "Call mum");
    renderApp();
    await screen.findByText("Buy milk");
    const slow = gate();
    server.use(
      http.get(`${BASE}/todos`, async ({ request }) => {
        if (new URL(request.url).searchParams.get("q") === "m") await slow.promise; // the FIRST search is slow
        return undefined;
      }),
    );
    await userEvent.type(screen.getByLabelText("Search"), "m"); // slow request starts
    await userEvent.type(screen.getByLabelText("Search"), "u"); // "mu": a newer, fast request
    await waitFor(() => expect(screen.queryByText("Buy milk")).not.toBeInTheDocument());
    slow.open(); // the old answer ("m" matches both) arrives now
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText("Call mum")).toBeInTheDocument();
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument();
  });
});
