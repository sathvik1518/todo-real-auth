import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { describeError } from "../messages";

interface Props {
  mode: "signin" | "signup";
}

/** The sign-in page and the sign-up page are the same form with different words and a different action. */
export default function AuthForm({ mode }: Props) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status === "signedIn") return <Navigate to={from} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (mode === "signin" ? auth.signIn : auth.signUp)(email, password);
      navigate(from, { replace: true });
    } catch (e) {
      setError(describeError(e)); // for a wrong email AND a wrong password this is the same sentence, straight from the server
    } finally {
      setBusy(false);
    }
  }

  const isSignIn = mode === "signin";
  return (
    <main>
      <h1>{isSignIn ? "Sign in" : "Create account"}</h1>
      {isSignIn && auth.notice && <p role="status">{auth.notice}</p>}
      <form className="stack" onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={isSignIn ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {!isSignIn && <p className="muted">At least 8 characters.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {isSignIn ? "Sign in" : "Create account"}
        </button>
      </form>
      <p className="muted">
        {isSignIn ? (
          <>
            No account? <Link to="/signup">Create one</Link>
          </>
        ) : (
          <>
            Already have an account? <Link to="/signin">Sign in</Link>
          </>
        )}
      </p>
    </main>
  );
}
