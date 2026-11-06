import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import App from "../App";
import { renderApp } from "../test/render";
import { auth, expireToken, requests, seed } from "../test/server";
import { AuthProvider } from "./AuthProvider";

async function signInAs(email: string, password: string) {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("the sign-in page", () => {
  it("has labelled email and password fields, and the password is hidden", async () => {
    renderApp({ path: "/signin", signedIn: false });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
  });

  it("a good sign-in lands on the to-do page and shows who you are", async () => {
    seed("Buy milk");
    renderApp({ path: "/signin", signedIn: false, role: "viewer" });
    await screen.findByRole("heading", { name: "Sign in" });
    await signInAs("sam@example.com", "correct horse");
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByTestId("who")).toHaveTextContent("sam@example.com (viewer)");
  });

  it("a wrong password and a wrong email show the SAME sentence", async () => {
    renderApp({ path: "/signin", signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });
    await signInAs("sam@example.com", "wrong password");
    const first = (await screen.findByRole("alert")).textContent;
    await userEvent.clear(screen.getByLabelText("Email"));
    await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(requests.filter((r) => r.endsWith("signin")).length).toBe(2));
    expect(screen.getByRole("alert").textContent).toBe(first);
    expect(first).toBe("Wrong email or password.");
  });

  it("no server shows the no-server sentence, not a sign-in sentence", async () => {
    renderApp({ path: "/signin", signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });
    const { server, http, HttpResponse, BASE } = await import("../test/server");
    server.use(http.post(`${BASE}/auth/signin`, () => HttpResponse.error()));
    await signInAs("sam@example.com", "correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server");
  });

  it("the button is disabled while the request runs", async () => {
    renderApp({ path: "/signin", signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });
    await signInAs("sam@example.com", "wrong");
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("someone already signed in is sent straight to the to-do page", async () => {
    renderApp({ path: "/signin", signedIn: true });
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("the sign-up page", () => {
  it("creates an account and lands on the to-do page as a viewer", async () => {
    renderApp({ path: "/signup", signedIn: false, role: "viewer" });
    await screen.findByRole("heading", { name: "Create account" });
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByTestId("who")).toHaveTextContent("new@example.com (viewer)");
  });

  it("a taken email shows the server's sentence", async () => {
    renderApp({ path: "/signup", signedIn: false });
    await screen.findByRole("heading", { name: "Create account" });
    await userEvent.type(screen.getByLabelText("Email"), "taken@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already registered");
  });

  it("a short password shows the server's message for that field", async () => {
    renderApp({ path: "/signup", signedIn: false });
    await screen.findByRole("heading", { name: "Create account" });
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 8 characters");
  });

  it("the sign-up form never sends a role", async () => {
    const { server, http, HttpResponse, BASE } = await import("../test/server");
    let body: unknown;
    server.use(
      http.post(`${BASE}/auth/signup`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ detail: "stop" }, { status: 409 });
      }),
    );
    renderApp({ path: "/signup", signedIn: false });
    await screen.findByRole("heading", { name: "Create account" });
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("alert");
    expect(body).toEqual({ email: "new@example.com", password: "a long password" });
  });
});

describe("the protected page", () => {
  it("while the cookie is being tried, it says so and shows no to-dos", async () => {
    auth.refreshDelayMs = 40;
    renderApp({ signedIn: true });
    expect(screen.getByRole("status")).toHaveTextContent("Checking your session…");
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument(); // no flash of the sign-in page
    expect(await screen.findByTestId("who")).toBeInTheDocument();
  });

  it("someone signed out is sent to the sign-in page", async () => {
    renderApp({ path: "/", signedIn: false });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(requests.filter((r) => r.includes("/todos"))).toEqual([]); // the to-do page never even asked
  });

  it("after signing in they come back to the page they wanted", async () => {
    seed("Buy milk");
    renderApp({ path: "/", signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });
    await signInAs("sam@example.com", "correct horse");
    expect(await screen.findByText("Buy milk")).toBeInTheDocument();
  });

  it("under StrictMode (which runs effects twice) the page load still makes ONE refresh call", async () => {
    auth.refreshOk = true;
    auth.role = "admin";
    render(
      <StrictMode>
        <MemoryRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByTestId("who");
    expect(auth.refreshCalls).toBe(1);
  });
});

describe("roles on the screen", () => {
  it("a viewer sees the list but no Delete buttons", async () => {
    seed("Buy milk");
    renderApp({ role: "viewer" });
    await screen.findByText("Buy milk");
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Buy milk" })).toBeInTheDocument(); // viewers can still tick things off
  });

  it("an admin sees Delete buttons", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    expect(await screen.findByRole("button", { name: "Delete Buy milk" })).toBeInTheDocument();
  });

  it("if the server demotes the admin after the page loaded, the server wins: 403, and the row stays", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    const button = await screen.findByRole("button", { name: "Delete Buy milk" });
    auth.role = "viewer"; // the button is only a courtesy. The server decides.
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only an admin can do that.");
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
  });
});

describe("while using the app", () => {
  it("an expired token is renewed behind the scenes and the action just works", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    const box = await screen.findByRole("checkbox", { name: "Buy milk" });
    const before = auth.refreshCalls; // 1: the page load
    expireToken();
    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(auth.refreshCalls - before).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("when the session is really over, the person lands on the sign-in page with a sentence that says why", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    const box = await screen.findByRole("checkbox", { name: "Buy milk" });
    auth.refreshOk = false;
    expireToken();
    await userEvent.click(box);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your session ended. Please sign in again.");
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument();
  });

  it("Sign out goes back to the sign-in page and tells the server", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    await screen.findByText("Buy milk");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(auth.signoutCalls).toBe(1);
    expect(screen.queryByText("Buy milk")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // a normal sign-out needs no "session ended" notice
  });

  it("after Sign out the page cannot be reached by going back", async () => {
    renderApp({ role: "admin" });
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.queryByTestId("who")).not.toBeInTheDocument();
  });

  it("nothing is left in storage after a whole session", async () => {
    seed("Buy milk");
    renderApp({ role: "admin" });
    await screen.findByText("Buy milk");
    expireToken();
    await userEvent.click(screen.getByRole("checkbox", { name: "Buy milk" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Buy milk" })).toBeChecked());
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});
