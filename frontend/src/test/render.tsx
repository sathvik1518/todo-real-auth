import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { auth } from "./server";

/**
 * Renders the whole app at a path.
 * signedIn: the refresh cookie still works, so the app signs itself in on load (as after a page reload).
 */
export function renderApp(options: { path?: string; signedIn?: boolean; role?: "viewer" | "admin" } = {}) {
  const { path = "/", signedIn = true, role = "admin" } = options;
  auth.refreshOk = signedIn;
  auth.role = role;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
