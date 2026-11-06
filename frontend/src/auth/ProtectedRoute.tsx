import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

/** Pages inside this route need a signed-in person. Everyone else is sent to /signin and comes back afterwards. */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <p role="status">Checking your session…</p>; // not a redirect yet: the cookie may still sign us in
  if (status === "signedOut") return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
