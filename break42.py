"""Break each sign-in rule once on purpose and check that the tests notice.
Run from the project folder:   python3 break42.py          (all)     or    python3 break42.py "cookie" "refresh"   (only matching names)
Each case edits one file, runs the right test suite, expects it to FAIL, then puts the file back."""
import pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).parent
B, F = ROOT / "backend", ROOT / "frontend"
APP, SRC = B / "app", F / "src"

# (name, file, old text, new text, suite)
CASES = [
  # ---- backend ----
  ("token decoded without checking the signature or algorithm", APP/"security.py", 'algorithms=[ALGORITHM], options={"require": ["exp", "sub"]}', 'options={"verify_signature": False, "require": ["exp", "sub"]}', "py"),
  ("expiry of the access token not checked", APP/"security.py", 'options={"require": ["exp", "sub"]}', 'options={"require": ["exp", "sub"], "verify_exp": False}', "py"),
  ("access token lives a whole day", APP/"settings.py", "access_ttl_seconds: int = 300", "access_ttl_seconds: int = 86400", "py"),
  ("cookie is not HttpOnly", APP/"auth.py", "httponly=True,  # JavaScript", "httponly=False,  # JavaScript", "py"),
  ("cookie path is / instead of narrow", APP/"auth.py", 'COOKIE_PATH = "/api/auth"', 'COOKIE_PATH = "/"', "py"),
  ("cookie has no explicit SameSite", APP/"auth.py", 'samesite="strict",  # stated', "samesite=None,  # stated", "py"),
  ("sign-up accepts a role from the client", APP/"schemas.py", 'The client never chooses its role.\n    model_config = ConfigDict(extra="forbid", strict=True)', 'The client never chooses its role.\n    model_config = ConfigDict(strict=True)', "py"),
  ("everyone who signs up is an admin", APP/"auth.py", 'role = "admin" if body.email in settings.admin_emails else "viewer"', 'role = "admin"', "py"),
  ("role is taken from the token, not the database", APP/"auth.py", '            raise unauthorized("Invalid token.")\n        return user', '            raise unauthorized("Invalid token.")\n        user = {**dict(user), "role": claims["role"]}\n        return user', "py"),
  ("password stored as plain text", APP/"auth.py", "hasher.hash(body.password)", "body.password", "py"),
  ("Argon2 cost turned down in production", APP/"security.py", "    return PasswordHasher(time_cost=1, memory_cost=8, parallelism=1) if settings.fast_hash else PasswordHasher()", "    return PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)", "py"),
  ("wrong email and wrong password give different messages", APP/"auth.py", 'if not user or not ok:\n                raise HTTPException(status_code=401, detail=BAD_LOGIN)', 'if not user:\n                raise HTTPException(status_code=401, detail="No account with that email.")\n            if not ok:\n                raise HTTPException(status_code=401, detail=BAD_LOGIN)', "py"),
  ("unknown email skips the password check (timing leak)", APP/"auth.py", 'verify_password(hasher, user["password_hash"] if user else dummy_hash, body.password)', 'verify_password(hasher, user["password_hash"], body.password) if user else False', "py"),
  ("a viewer may delete", APP/"main.py", "dependencies=[Depends(auth.require_admin)]", "dependencies=signed_in", "py"),
  ("to-do list readable without signing in", APP/"main.py", '@app.get("/api/todos", response_model=list[TodoOut], dependencies=signed_in)', '@app.get("/api/todos", response_model=list[TodoOut])', "py"),
  ("refresh token can be used again (no rotation)", APP/"auth.py", '            conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?", (row["id"],))  # each refresh', '            pass  # each refresh', "py"),
  ("a replayed old token does not cancel the session", APP/"auth.py", '                conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?", (row["user_id"],))\n', '', "py"),
  ("sign-out does not cancel the refresh token", APP/"auth.py", 'conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?", (hash_refresh_token(refresh_token),))', "pass", "py"),
  ("refresh token stored raw instead of hashed", APP/"auth.py", "(user[\"id\"], hash_refresh_token(refresh), int(time.time())", "(user[\"id\"], refresh, int(time.time())", "py"),
  ("a refused refresh leaves the dead cookie in place", APP/"auth.py", "        clear_cookie(res)\n        return res", "        return res", "py"),
  ("e-mail addresses are case sensitive", APP/"schemas.py", "value = value.strip().lower()", "value = value.strip()", "py"),
  ("CORS: credentials not allowed", APP/"main.py", "        allow_credentials=True,", "", "py"),
  ("CORS: Authorization header not allowed", APP/"main.py", 'allow_headers=["Content-Type", "Authorization"]', 'allow_headers=["Content-Type"]', "py"),
  # ---- frontend ----
  ("token also saved in localStorage", SRC/"session.ts", "  token = reply.access_token;\n  setState", '  token = reply.access_token;\n  localStorage.setItem("token", reply.access_token);\n  setState', "ts"),
  ("no single-flight: every call refreshes by itself", SRC/"session.ts", "  inflight ??= renewNow().finally(() => {\n    inflight = null;\n  });\n  return inflight;", "  return renewNow();", "ts"),
  ("a late 401 refreshes again instead of using the new token", SRC/"session.ts", "  if (token && token !== failedWith) return Promise.resolve(token);\n", "", "ts"),
  ("retry more than once after a 401", SRC/"api/client.ts", "if (fresh) res = await send(base, path, options, fresh);", "for (let i = 0; i < 3 && fresh && res.status === 401; i++) res = await send(base, path, options, fresh);", "ts"),
  ("a 403 triggers a refresh", SRC/"api/client.ts", "if (res.status === 401 && useAuth) {", "if ((res.status === 401 || res.status === 403) && useAuth) {", "ts"),
  ("sign-in calls also try to refresh on a 401", SRC/"api/client.ts", "const useAuth = options.auth !== false && hooks !== null;", "const useAuth = hooks !== null;", "ts"),
  ("the cookie is not sent cross-origin", SRC/"api/client.ts", 'credentials: "include",', 'credentials: "same-origin",', "ts"),
  ("no Authorization header", SRC/"api/client.ts", 'if (token) headers["Authorization"] = `Bearer ${token}`;', "", "ts"),
  ("a refused refresh does not sign the person out", SRC/"session.ts", "if (error instanceof ServerError && error.status === 401) {", "if (false as boolean) {", "ts"),
  ("sign out keeps the token in memory", SRC/"session.ts", "    // The token variable is cleared below either way.\n  }\n  token = null;", "    // The token variable is cleared below either way.\n  }", "ts"),
  ("sign-up form sends a role", SRC/"session.ts", 'body: { email, password }, auth: false }));\n}\n/** Always', 'body: { email, password, role: "admin" }, auth: false }));\n}\n/** Always', "ts"),
  ("Delete shown to viewers", SRC/"pages/TodoPage.tsx", "{isAdmin && (", "{true && (", "ts"),
  ("protected page does not redirect", SRC/"auth/ProtectedRoute.tsx", '  if (status === "signedOut") return <Navigate to="/signin" replace state={{ from: location.pathname }} />;\n', "", "ts"),
  ("protected page redirects while still checking the cookie", SRC/"auth/ProtectedRoute.tsx", 'if (status === "loading") return <p role="status">Checking your session…</p>;', 'if (status === "loading") return <Navigate to="/signin" replace />;', "ts"),
  ("password field shows the text", SRC/"pages/AuthForm.tsx", 'type="password"', 'type="text"', "ts"),
]

def run(suite):
    if suite == "py":
        return subprocess.run([sys.executable, "-m", "pytest", "-q", "-x"], cwd=B, capture_output=True, text=True).returncode
    r1 = subprocess.run("npx tsc --noEmit", shell=True, cwd=F, capture_output=True, text=True)
    r2 = subprocess.run("npx vitest run", shell=True, cwd=F, capture_output=True, text=True)
    return r1.returncode or r2.returncode

only = sys.argv[1:]  # optional: part of a case name, to run just those
print("baseline (nothing broken):")
suites = {c[4] for c in CASES if not only or any(o in c[0] for o in only)}
for s in sorted(suites):
    code = run(s)
    print(f"  {s}: {'pass' if code == 0 else 'FAIL'}")
    if code:
        sys.exit("baseline must be green before breaking things")

missed = ran = 0
for name, path, old, new, suite in CASES:
    if only and not any(o in name for o in only):
        continue
    ran += 1
    text = path.read_text()
    if old not in text:
        print(f"SKIP   {name}  (text not found in {path.name})")
        missed += 1
        continue
    path.write_text(text.replace(old, new, 1))
    try:
        code = run(suite)
    finally:
        path.write_text(text)
    caught = code != 0
    missed += not caught
    print(f"{'CAUGHT' if caught else 'MISSED'}  {name}", flush=True)
print(f"\n{ran - missed}/{ran} broken rules were caught by the tests.")
sys.exit(1 if missed else 0)
