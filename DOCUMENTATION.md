# To-do App with Real Sign-in: Argon2, Short Access Tokens and an HttpOnly Refresh Cookie

**Day 42 Mini Capstone, RealAuth**  
**Project folder:** `todo-real-auth`

---

## 1. Goal

Add sign-in to the to-do app. The task (Day 42 Deep Dive, Mini Capstone) asked for:

1. **Backend:** sign-up, sign-in, refresh and sign-out endpoints; **Argon2** password hashing; access tokens that last **a few minutes**; the refresh token as an **HttpOnly cookie with a narrow Path and an explicit SameSite**; a **viewer can read** tasks and **only an admin can delete**.
2. **Frontend:** sign-in and sign-up pages, an **`AuthProvider`**, a **`ProtectedRoute`**, **one request function** that adds the token and **renews it once**, and a **role-aware Delete button**.
3. **Safety:** nothing in `localStorage`; **the server decides roles**; a wrong email and a wrong password give **the same message**.
4. **Four proof numbers:** (1) how many refresh calls happen when three requests meet an expired token; (2) the cookie's flags as the browser stored them; (3) the status code when a viewer sends DELETE by hand; (4) what is left in storage and `document.cookie`.

The hints at the bottom of the screenshot were slightly cut off. Everything that was visible is covered: build the backend first and test it, use a very short token life while testing, read `detail` from FastAPI errors, always pass `algorithms=[...]` when decoding, count requests in Playwright with `page.on("request")`, and break each rule once.

This project **extends the Day 41 project** (`todo-fastapi-connect`): the same to-do routes, API layer, adapter and typed environment file, now behind a sign-in. Day 41 is not needed to run it; everything is included.

Think of a members-only gym. At the desk you show your ID once (sign in) and get a **day wristband** that lasts a few minutes (the access token). Every door checks the wristband. When it expires, you do not queue at the desk again: you hand over a **sealed membership card** (the refresh cookie) that you cannot read yourself, but the desk can. It gives you a new wristband and a **new sealed card**, and the old card is torn up. If someone shows a torn-up card, the desk cancels everything on that membership. Members may use the machines (viewer); only staff may remove equipment (admin).

The rules this project is built around:

- **The password is never stored.** Only an Argon2 hash is, with a random salt.
- **The access token is short, and lives only in a variable.** Never in `localStorage`, never in `sessionStorage`.
- **The refresh token is a cookie that JavaScript cannot read** (`HttpOnly`), that the browser sends only to `/api/auth` (narrow `Path`), and that is stored only as a hash on the server.
- **Each refresh token works once.** An old one coming back cancels the whole session.
- **The server decides who is an admin**, from its own list, and reads the role from its **database** on every request, not from the token.
- **Three requests that meet an expired token make one refresh call**, because two at once would cancel each other.
- **Every failure that could leak whether an email exists gives the same answer.**

---

## 2. Tools

| Tool | Role |
|---|---|
| FastAPI 0.162 + Uvicorn | The backend |
| `argon2-cffi` 25.1 (Argon2id) | Password hashing |
| `PyJWT` 2.15 (HS256) | Signing and reading the short access token |
| SQLite | Users, refresh tokens (as hashes) and to-dos |
| Vite 8 + React 19 + TypeScript 7 | The frontend, with the dev proxy and `--mode cors` from Day 41 |
| React Router 7 (`react-router-dom`) | The sign-in and sign-up pages, and the protected route |
| Vitest 5 + MSW 3 + React Testing Library | Frontend tests against a fake sign-in server |
| pytest + httpx (`TestClient`) | Backend tests |
| Playwright (Chromium) | `scripts/check-browser.mjs`: real browser, real backend, the four proof numbers |

---

## 3. Project structure

```
todo-real-auth/
├── README.md
├── DOCUMENTATION.md
├── .gitignore
├── break42.py                  (breaks 38 rules once each; the tests must notice)
├── backend/
│   ├── requirements.txt, requirements-dev.txt, pytest.ini
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py             (to-do routes, CORS, wiring)
│   │   ├── auth.py             (sign-up, sign-in, refresh, sign-out, who-are-you, admin-only)
│   │   ├── security.py         (hash a password, sign a token, make a refresh token)
│   │   ├── settings.py         (token life, secret, admin list, secure cookie: from environment variables)
│   │   ├── schemas.py, db.py
│   └── tests/
│       ├── conftest.py
│       ├── test_api.py         (75: the Day 41 contract, unchanged, now run as a signed-in admin)
│       ├── test_auth.py        (90)
│       └── test_cors.py        (21)
└── frontend/
    ├── package.json, tsconfig.json, vite.config.ts, index.html
    ├── .env.development, .env.cors, .env.test, .env.example
    ├── scripts/check-browser.mjs
    ├── proof/                  (screenshots and proof-numbers.json written by the browser check)
    └── src/
        ├── session.ts          (the token in memory, renew once, sign in/up/out)
        ├── auth/               (AuthProvider.tsx, ProtectedRoute.tsx, auth-ui.test.tsx)
        ├── pages/              (AuthForm.tsx for both sign-in and sign-up, TodoPage.tsx, TodoPage.test.tsx)
        ├── api/                (client.ts now adds the token and renews it once; adapter, env, errors, todos)
        ├── App.tsx, main.tsx, messages.ts, types.ts, vite-env.d.ts, styles.css
        ├── session.test.ts
        └── test/ (setup.ts, server.ts with a fake sign-in server, render.tsx)
```

---

## 4. Setup commands

```bash
# backend
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1          # Windows PowerShell   (Mac/Linux: source .venv/bin/activate)
pip install -r requirements-dev.txt

# frontend
cd ..\frontend
npm install
npx playwright install chromium       # only for the real-browser check
```

**`package.json` scripts**

```json
"dev": "vite",
"dev:cors": "vite --mode cors",
"build": "tsc --noEmit && vite build",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"proof": "node scripts/check-browser.mjs"
```

---

## 5. The idea: a short wristband, a sealed card, and one desk visit at a time

**The contract** (also at the top of `main.py`, and live at `/docs`):

| Route | Success | Errors |
|---|---|---|
| `POST /api/auth/signup` | **201** access token + user, refresh cookie set | 409 email taken, 422 bad body |
| `POST /api/auth/signin` | 200 access token + user, refresh cookie set | 401 "Wrong email or password." |
| `POST /api/auth/refresh` | 200 new access token + **new** cookie | 401 no, used or expired cookie |
| `POST /api/auth/signout` | **204**, cookie cleared, refresh token cancelled | none (always 204) |
| `GET /api/auth/me` | 200 who am I | 401 |
| every `/api/todos` route | as in Day 41, but needs `Authorization: Bearer <token>` | 401 without a valid token |
| `DELETE /api/todos/{id}` | 204 | **403** if the person is not an admin |

**401 versus 403.** 401 means *"I do not know who you are"* (no token, a bad token, an expired token). 403 means *"I know who you are, and you are not allowed"*. The page treats them differently: a 401 makes it renew the token and try again, a 403 is just a sentence to show. Renewing after a 403 would be pointless and would hide the real answer.

**The life of a session.**

```
 sign in ──▶ server: checks the Argon2 hash
             sends:  access token (5 min)        ──▶ kept in a JavaScript variable
                     refresh cookie (7 days)     ──▶ HttpOnly, Path=/api/auth, SameSite=Strict
 every call ──▶ Authorization: Bearer <access token>      (the cookie is NOT sent: wrong path)
 token expired ──▶ 401 ──▶ POST /api/auth/refresh  (the browser adds the cookie by itself)
                           server: cancels that cookie's token, issues a new pair
                    ──▶ the call is tried ONCE more with the new token
 page reload ──▶ the variable is empty ──▶ refresh ──▶ signed in again, no password typed
 sign out ──▶ POST /api/auth/signout ──▶ cookie cleared, token cancelled on the server
```

**Why two tokens.** A token that lives for a few minutes does little harm if it leaks, but asking for a password every few minutes is unusable. The cookie closes the gap: the browser keeps it, and **JavaScript can never read it**, so a script injected into the page cannot steal it. The short token does the work on every call; the cookie is used only to get a new one.

**Why the cookie has a narrow `Path` and `SameSite=Strict`.** `Path=/api/auth` means the browser sends the cookie only to the sign-in routes, never along with a to-do request. `SameSite=Strict` means it is never sent when the request comes from another site, which blocks the usual cross-site request trick. Both are written out on purpose, not left to the browser's default. In production the cookie is also `Secure` (https only); that is a setting (`COOKIE_SECURE=1`), because the browser would not store a Secure cookie from a plain http address on other machines.

**Why each refresh token works once (rotation).** A stolen cookie is only useful until the real person refreshes next. If an old token comes back, someone has a copy, so the server cancels **every** session of that user. This is why the page must never send two refresh calls at once: the second would carry a token the first just used.

**Why one refresh call for three requests (single flight).** Three calls leave with the same expired token and all get a 401. The first one starts the refresh; the others wait for it. Then each retries with the new token. A call whose 401 arrives *late*, after the renewal already finished, notices the token has changed and just retries, with no second refresh. The browser check measures this: 3 requests, **1** refresh call.

**Why the role comes from the database.** A role written into a token stays true until the token expires, even if the person was demoted or deleted. Reading it from the database on each request means a change takes effect on the next call. A test signs a token that *claims* admin with the real secret, and the delete is still refused.

**Why a wrong email and a wrong password give the same answer.** If they differed, anyone could test which emails have accounts. Same status, same sentence, and the same amount of work: for an unknown email the server still checks the password against a dummy hash, because an instant answer would tell the same story through timing.

**Why `algorithms=["HS256"]` is always passed.** Without it the library may accept whatever algorithm the token itself claims, including `none` (no signature). Tests send an `alg: none` token and a token signed with another algorithm; both get a 401.

**What the screen does and does not decide.** The Delete button is shown only to admins, as a courtesy. It protects nothing: the server's 403 does. A test turns the person into a viewer after the page loaded and clicks the button anyway; the server refuses and the row stays.

**What a sign-in does to Day 41.** The to-do calls now carry a header, `Authorization`, that a plain request does not send. In cross-origin mode the browser therefore sends a preflight for **every** to-do call, including GET (the Day 41 list GET needed none). The backend allows the header, allows credentials, and still lists exact origins (a `*` is not allowed together with credentials).

---

## 6. The code

### `backend/app/settings.py`

```python
import os
import secrets
from dataclasses import dataclass, field


@dataclass
class Settings:
    """Everything that changes between your laptop, the tests and a real server. Read from environment variables."""

    jwt_secret: str = field(default_factory=lambda: secrets.token_urlsafe(48))  # random per start: tokens stop working after a restart
    access_ttl_seconds: int = 300  # access tokens live a few minutes
    refresh_ttl_seconds: int = 7 * 24 * 3600
    cookie_secure: bool = False  # True on a real https site. Browsers accept Secure cookies on http://localhost too.
    admin_emails: frozenset[str] = frozenset()  # signing up with one of these addresses makes an admin. The client never chooses a role.
    fast_hash: bool = False  # tests only: cheaper Argon2 so 100 sign-ups do not take a minute

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        s = cls()
        if env.get("JWT_SECRET"):
            s.jwt_secret = env["JWT_SECRET"]
        s.access_ttl_seconds = int(env.get("ACCESS_TTL_SECONDS", s.access_ttl_seconds))
        s.refresh_ttl_seconds = int(env.get("REFRESH_TTL_SECONDS", s.refresh_ttl_seconds))
        s.cookie_secure = env.get("COOKIE_SECURE", "0") == "1"
        s.admin_emails = frozenset(e.strip().lower() for e in env.get("ADMIN_EMAILS", "").split(",") if e.strip())
        return s
```

### `backend/app/security.py` (hash, sign, refresh token)

```python
"""The three security jobs, each in one small place: hash a password, sign an access token, make a refresh token."""
import hashlib
import secrets
import time

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .settings import Settings

ALGORITHM = "HS256"


def make_hasher(settings: Settings) -> PasswordHasher:
    # Argon2id with the library's recommended cost. Tests use a cheap setting (the algorithm is the same).
    return PasswordHasher(time_cost=1, memory_cost=8, parallelism=1) if settings.fast_hash else PasswordHasher()


def verify_password(hasher: PasswordHasher, stored_hash: str, password: str) -> bool:
    try:
        return hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def make_access_token(settings: Settings, user_id: int, role: str) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "role": role, "iat": now, "exp": now + settings.access_ttl_seconds}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def read_access_token(settings: Settings, token: str) -> dict:
    """Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError.

    algorithms=[...] is always given. Without it, a forged token that says "alg: none" could be accepted.
    """
    return jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]})


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()  # fine for a long random value (unlike a password)
```

### `backend/app/auth.py` (the sign-in routes and the two checks)

```python
"""Sign-up, sign-in, refresh, sign-out, and the two checks the to-do routes use: "who are you" and "are you an admin"."""
import sqlite3
import time
from dataclasses import dataclass
from typing import Annotated

import jwt
from argon2 import PasswordHasher
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import db
from .schemas import SignIn, SignUp, TokenOut, UserOut
from .security import (
    hash_refresh_token,
    make_access_token,
    make_hasher,
    new_refresh_token,
    read_access_token,
    verify_password,
)
from .settings import Settings

COOKIE_NAME = "refresh_token"
COOKIE_PATH = "/api/auth"  # narrow: the browser sends this cookie ONLY to the sign-in routes, never with a to-do request
BAD_LOGIN = "Wrong email or password."  # one sentence for "no such email" and "wrong password"
_bearer = HTTPBearer(auto_error=False)


def unauthorized(message: str) -> HTTPException:
    return HTTPException(status_code=401, detail=message, headers={"WWW-Authenticate": "Bearer"})


@dataclass
class Auth:
    router: APIRouter
    current_user: object  # FastAPI dependency: 401 unless a valid access token
    require_admin: object  # FastAPI dependency: 401, then 403 unless the user is an admin


def build_auth(path: str, settings: Settings) -> Auth:
    hasher: PasswordHasher = make_hasher(settings)
    dummy_hash = hasher.hash("not-a-real-password")  # compared against when the email is unknown, so both failures take the same time
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    def set_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            max_age=settings.refresh_ttl_seconds,
            path=COOKIE_PATH,
            httponly=True,  # JavaScript cannot read it, so a script injected into the page cannot steal it
            secure=settings.cookie_secure,
            samesite="strict",  # stated on purpose, not left to the browser's default
        )

    def clear_cookie(response: Response) -> None:
        response.delete_cookie(key=COOKIE_NAME, path=COOKIE_PATH, httponly=True, secure=settings.cookie_secure, samesite="strict")

    def issue(conn: sqlite3.Connection, response: Response, user: sqlite3.Row, status: int = 200) -> TokenOut:
        """Make a new refresh token (stored as a hash), set it as the cookie, and return a new access token."""
        refresh = new_refresh_token()
        conn.execute(
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
            (user["id"], hash_refresh_token(refresh), int(time.time()) + settings.refresh_ttl_seconds),
        )
        set_cookie(response, refresh)
        response.status_code = status
        return TokenOut(
            access_token=make_access_token(settings, user["id"], user["role"]),
            expires_in=settings.access_ttl_seconds,
            user=UserOut(id=user["id"], email=user["email"], role=user["role"]),
        )

    @router.post("/signup", response_model=TokenOut, status_code=201)
    def signup(body: SignUp, response: Response):
        role = "admin" if body.email in settings.admin_emails else "viewer"  # the SERVER decides
        with db.connect(path) as conn:
            try:
                cur = conn.execute(
                    "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)", (body.email, hasher.hash(body.password), role)
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="That email is already registered. Try signing in.")
            user = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
            return issue(conn, response, user, 201)

    @router.post("/signin", response_model=TokenOut)
    def signin(body: SignIn, response: Response):
        email = body.email.strip().lower()
        with db.connect(path) as conn:
            user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            ok = verify_password(hasher, user["password_hash"] if user else dummy_hash, body.password)
            if not user or not ok:
                raise HTTPException(status_code=401, detail=BAD_LOGIN)
            return issue(conn, response, user)

    def refresh_refused(message: str) -> JSONResponse:
        # A returned response (not a raised HTTPException) is used here, because a raised error throws away the Set-Cookie header
        # that would clear the dead cookie.
        res = JSONResponse(status_code=401, content={"detail": message}, headers={"WWW-Authenticate": "Bearer"})
        clear_cookie(res)
        return res

    @router.post("/refresh", response_model=TokenOut)
    def refresh(response: Response, refresh_token: Annotated[str | None, Cookie()] = None):
        if not refresh_token:
            raise unauthorized("Not signed in.")
        digest = hash_refresh_token(refresh_token)
        with db.connect(path) as conn:
            row = conn.execute("SELECT * FROM refresh_tokens WHERE token_hash = ?", (digest,)).fetchone()
            if row is None or row["expires_at"] < time.time():
                return refresh_refused("Please sign in again.")
            if row["revoked"]:
                # An old token came back. Either a thief or a stale copy used it. Cancel every session of that user.
                conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?", (row["user_id"],))
                return refresh_refused("Please sign in again.")
            user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
            conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?", (row["id"],))  # each refresh token works once (rotation)
            return issue(conn, response, user)

    @router.post("/signout", status_code=204)
    def signout(refresh_token: Annotated[str | None, Cookie()] = None):
        response = Response(status_code=204)
        if refresh_token:
            with db.connect(path) as conn:
                conn.execute("UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?", (hash_refresh_token(refresh_token),))
        clear_cookie(response)
        return response

    def current_user(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]) -> sqlite3.Row:
        if credentials is None:
            raise unauthorized("Sign in to continue.")
        try:
            claims = read_access_token(settings, credentials.credentials)
        except jwt.ExpiredSignatureError:
            raise unauthorized("Your session expired.")
        except jwt.InvalidTokenError:
            raise unauthorized("Invalid token.")
        with db.connect(path) as conn:
            # The role comes from the DATABASE, not from the token, so a role change or a deleted user takes effect at once.
            user = conn.execute("SELECT * FROM users WHERE id = ?", (claims["sub"],)).fetchone()
        if user is None:
            raise unauthorized("Invalid token.")
        return user

    def require_admin(user: Annotated[sqlite3.Row, Depends(current_user)]) -> sqlite3.Row:
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Only an admin can do that.")
        return user

    @router.get("/me", response_model=UserOut)
    def me(user: Annotated[sqlite3.Row, Depends(current_user)]):
        return UserOut(id=user["id"], email=user["email"], role=user["role"])

    return Auth(router=router, current_user=current_user, require_admin=require_admin)
```

### `backend/app/main.py` (to-do routes and CORS)

```python
"""
The to-do API.

Run:   python -m uvicorn app.main:app --reload --port 8000   (set ADMIN_EMAILS=you@example.com to get an admin)        (from the backend folder)
Docs:  http://localhost:8000/docs         The contract as data: http://localhost:8000/openapi.json

The contract (every path starts with /api, and none ends with a slash):

  POST   /api/auth/signup        201  access token + user, refresh cookie set      409 email taken   422 bad body
  POST   /api/auth/signin        200  access token + user, refresh cookie set      401 wrong email or password
  POST   /api/auth/refresh       200  new access token, new refresh cookie         401 no / used / expired cookie
  POST   /api/auth/signout       204  cookie cleared, refresh token cancelled
  GET    /api/auth/me            200  who am I                                      401

  Every to-do route below needs   Authorization: Bearer <access token>   (401 without one)

  GET    /api/todos?q=&done=     200  list           422 bad done value
  POST   /api/todos              201  created todo + Location header      422 bad body
  GET    /api/todos/{id}         200  todo           404 no such todo     422 id is not a number
  PATCH  /api/todos/{id}         200  updated todo   404                  422 bad body
  DELETE /api/todos/{id}         204  (no body)      404                  403 only an admin may delete
"""
import os
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .auth import build_auth
from .schemas import TodoCreate, TodoOut, TodoUpdate
from .settings import Settings

# The pages that may call this API from another origin. An exact list, never "*".
ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
NOT_FOUND = "No such to-do."


def create_app(db_path: str | None = None, settings: Settings | None = None) -> FastAPI:
    path = db_path or os.environ.get("TODO_DB", "todo.db")
    settings = settings or Settings.from_env()
    db.init_db(path)
    auth = build_auth(path, settings)
    signed_in = [Depends(auth.current_user)]  # 401 without a valid access token

    # redirect_slashes=False: "/api/todos/" is a 404 here, not a quiet 307 redirect.
    # A redirect to the wrong address breaks the browser's CORS check, and hides a mistake in the client.
    app = FastAPI(title="To-do API", redirect_slashes=False)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],  # PATCH must be listed, or the preflight for it fails
        allow_credentials=True,  # lets the browser send and accept the refresh cookie across origins. Needs exact origins, never "*".
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=["Location"],  # without this, the page's JavaScript cannot read the Location header
        max_age=600,  # the browser may reuse a preflight answer for 10 minutes (same address)
    )

    app.include_router(auth.router)

    @app.get("/api/todos", response_model=list[TodoOut], dependencies=signed_in)
    def list_todos(
        q: Annotated[str | None, Query(max_length=120)] = None,
        done: bool | None = None,
    ):
        sql, args = "SELECT * FROM todos WHERE 1=1", []
        if q:
            # like() treats % and _ as wildcards. Escape them so searching for "50%" means 50%.
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " AND title LIKE ? ESCAPE '\\'"
            args.append(f"%{escaped}%")
        if done is not None:
            sql += " AND done = ?"
            args.append(int(done))
        with db.connect(path) as conn:
            return [db.row_to_todo(r) for r in conn.execute(sql + " ORDER BY id", args)]

    @app.post("/api/todos", response_model=TodoOut, status_code=201, dependencies=signed_in)
    def create_todo(body: TodoCreate, response: Response):
        with db.connect(path) as conn:
            cur = conn.execute("INSERT INTO todos (title) VALUES (?)", (body.title,))
            row = conn.execute("SELECT * FROM todos WHERE id = ?", (cur.lastrowid,)).fetchone()
        response.headers["Location"] = f"/api/todos/{row['id']}"
        return db.row_to_todo(row)

    @app.get("/api/todos/{todo_id}", response_model=TodoOut, dependencies=signed_in)
    def get_todo(todo_id: int):
        with db.connect(path) as conn:
            row = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        return db.row_to_todo(row)

    @app.patch("/api/todos/{todo_id}", response_model=TodoOut, dependencies=signed_in)
    def update_todo(todo_id: int, body: TodoUpdate):
        changes = body.model_dump(exclude_none=True)  # only what was sent
        with db.connect(path) as conn:
            if conn.execute("SELECT 1 FROM todos WHERE id = ?", (todo_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail=NOT_FOUND)
            if "done" in changes:
                changes["done"] = int(changes["done"])
            sets = ", ".join(f"{column} = ?" for column in changes)  # column names come from our model, never from the client
            conn.execute(f"UPDATE todos SET {sets} WHERE id = ?", (*changes.values(), todo_id))
            row = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        return db.row_to_todo(row)

    @app.delete("/api/todos/{todo_id}", status_code=204, dependencies=[Depends(auth.require_admin)])  # viewers get 403
    def delete_todo(todo_id: int):
        with db.connect(path) as conn:
            deleted = conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,)).rowcount
        if not deleted:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        return Response(status_code=204)  # 204 means "done, and there is nothing to send back"

    return app


app = create_app()
```

### `backend/app/schemas.py`

```python
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_TITLE = 120


def _clean_title(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Title cannot be empty.")
    return value


class TodoCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)  # a stray field or "true" for a boolean is refused
    title: str = Field(max_length=MAX_TITLE)

    _trim = field_validator("title")(_clean_title)


class TodoUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str | None = Field(default=None, max_length=MAX_TITLE)
    done: bool | None = None

    @field_validator("title")
    @classmethod
    def _trim(cls, value):
        return value if value is None else _clean_title(value)

    @model_validator(mode="after")
    def _something_to_change(self):
        # {} and {"title": null} change nothing. That is a mistake in the request, so say so.
        if not self.model_fields_set or (self.title is None and self.done is None):
            raise ValueError("Send at least one of: title, done.")
        return self


class TodoOut(BaseModel):
    id: int
    title: str
    done: bool
    created_at: str


# ---- sign-in -------------------------------------------------------------------------------------------------------

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if len(value) > 254 or not _EMAIL.match(value):
        raise ValueError("Enter a valid email address.")
    return value


class SignUp(BaseModel):
    # extra="forbid": a body with "role": "admin" is refused. The client never chooses its role.
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str
    password: str = Field(min_length=8, max_length=128)

    _email = field_validator("email")(_clean_email)


class SignIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut
```

### `backend/app/db.py`

```python
import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)
"""


USERS = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('viewer', 'admin')),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)
"""

# Only a hash of each refresh token is stored, so a stolen database cannot be used to sign in.
REFRESH_TOKENS = """
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0
)
"""


def init_db(path: str) -> None:
    with connect(path) as conn:
        conn.execute(SCHEMA)
        conn.execute(USERS)
        conn.execute(REFRESH_TOKENS)


@contextmanager
def connect(path: str):
    """One short-lived connection per request. SQLite connections must not be shared between threads."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_todo(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "title": row["title"], "done": bool(row["done"]), "created_at": row["created_at"]}
```

### `backend/requirements.txt`

```text
fastapi==0.162.0
uvicorn==0.54.0
argon2-cffi==25.1.0
PyJWT==2.15.0
```

### `backend/requirements-dev.txt`

```text
-r requirements.txt
pytest==9.1.1
httpx==0.28.1
```

### `backend/pytest.ini`

```ini
[pytest]
pythonpath = .
testpaths = tests
```

### `frontend/.env.development` (proxy mode)

```bash
# Proxy mode: a relative address. The Vite dev server forwards /api to the backend.
VITE_API_BASE_URL=/api
```

### `frontend/.env.cors` (cross-origin mode)

```bash
# Cross-origin mode (npm run dev:cors): the page calls the backend directly, so the browser applies CORS.
VITE_API_BASE_URL=http://localhost:8000/api
```

### `frontend/.env.test`

```bash
# Tests run in jsdom, which needs a full address to call the fake server.
VITE_API_BASE_URL=http://localhost:8000/api
```

### `frontend/.env.example`

```bash
# Copy to .env.production (or set in your host) and change the address to your deployed API.
VITE_API_BASE_URL=https://your-api.example.com/api
```

### `frontend/vite.config.ts`

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two ways to reach the API (see .env.development and .env.cors):
//   npm run dev       the page asks /api/... on ITS OWN address, and this proxy forwards it to the backend. Same origin: no CORS.
//   npm run dev:cors  the page asks http://localhost:8000/api/... directly. Different origin: the browser checks CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // the backend only allows the page from port 5173
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: false } },
  },
  preview: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

### `frontend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "vite.config.ts"]
}
```

### `frontend/src/vite-env.d.ts`

```ts
// A STRICT description of import.meta.env.
//
// Vite's own types (`/// <reference types="vite/client" />`) add an "anything goes" rule to ImportMetaEnv:
//     [key: string]: any
// With that rule, import.meta.env.VITE_API_BASE_URI (a typo) is allowed and quietly becomes `undefined`.
// So this file does NOT load vite/client. It lists every variable the app may read, and nothing else.
// Every variable here must start with VITE_ to reach the browser. Add new ones here first.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly MODE: string; // "development", "cors", "production", "test"
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Because vite/client is not loaded, CSS imports need a line here (they only run for their side effect).
declare module "*.css";
```

### `frontend/src/types.ts`

```ts
// What the SCREEN uses. The server's own shape lives only in api/adapter.ts.
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: Date;
}

export type Filter = "all" | "active" | "completed";
```

### `frontend/src/api/env.ts`

```ts
/**
 * Reads the API address from the environment and fails LOUDLY if it is missing.
 * A trailing slash is removed, so base + "/todos" never becomes "...//todos".
 */
export function readApiBase(env: { VITE_API_BASE_URL?: string }): string {
  const value = env.VITE_API_BASE_URL?.trim();
  if (!value) {
    throw new Error("VITE_API_BASE_URL is not set. Add it to .env.development (see .env.example).");
  }
  return value.replace(/\/+$/, "");
}

export const API_BASE = readApiBase(import.meta.env);
```

### `frontend/src/api/errors.ts`

```ts
/** The server answered, and the answer was "no" (404, 422, 500...). */
export class ServerError extends Error {
  readonly status: number;
  /** For a 422: which field said what, e.g. { title: "Title cannot be empty." } */
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** There was no answer at all: the server is off, the network is down, or it took too long. */
export class NetworkError extends Error {
  readonly reason: "unreachable" | "timeout";

  constructor(reason: "unreachable" | "timeout") {
    super(reason === "timeout" ? "The server took too long to answer." : "Could not reach the server.");
    this.name = "NetworkError";
    this.reason = reason;
  }
}
```

### `frontend/src/api/client.ts` (adds the token, renews once)

```ts
import { API_BASE } from "./env";
import { NetworkError, ServerError } from "./errors";

export const DEFAULT_TIMEOUT_MS = 8000;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Becomes the query string. Undefined values are left out. Encoding is done for you. */
  query?: Record<string, string | boolean | undefined>;
  body?: unknown;
  /** The caller's own cancel signal (for example, when a component goes away). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Default true: add the access token, and if the server answers 401, renew it ONCE and try again. The /auth calls pass false. */
  auth?: boolean;
}

/** The sign-in code plugs itself in here. The API layer does not know how tokens are stored or renewed. */
export interface AuthHooks {
  getToken(): string | null;
  /** Called after a 401. `failedWith` is the token that was rejected. Resolves to a usable token, or null if the person is signed out. */
  renew(failedWith: string | null): Promise<string | null>;
}
let hooks: AuthHooks | null = null;
export function setAuthHooks(next: AuthHooks | null): void {
  hooks = next;
}

/** base + path + query string. URLSearchParams escapes "&", "=", spaces and the rest, so a search for "a & b" is safe. */
export function buildUrl(base: string, path: string, query: RequestOptions["query"] = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return `${base}${path}${text ? `?${text}` : ""}`;
}

/** FastAPI sends 422 as a list: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty." }] */
function readFieldErrors(detail: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!Array.isArray(detail)) return fields;
  for (const item of detail) {
    const loc = Array.isArray(item?.loc) ? item.loc : [];
    const field = String(loc[loc.length - 1] ?? "request");
    if (!(field in fields)) fields[field] = String(item?.msg ?? "Invalid value.").replace(/^Value error, /, "");
  }
  return fields;
}

async function toServerError(res: Response): Promise<ServerError> {
  let detail: unknown;
  try {
    detail = (await res.json()).detail;
  } catch {
    // the error body was not JSON (a proxy's error page, for example): use the generic message below
  }
  if (typeof detail === "string") return new ServerError(res.status, detail);
  const fieldErrors = readFieldErrors(detail);
  return new ServerError(res.status, `Request failed (${res.status}).`, fieldErrors);
}

/**
 * One attempt. Turns "no answer" into NetworkError, and lets a caller cancel pass through untouched.
 * A timeout is added to every attempt, and it still works when the caller passes its own signal.
 */
async function send(base: string, path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const { method = "GET", query, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = {};
  // A JSON content type is what makes a cross-origin POST or PATCH trigger a preflight. GET and DELETE send none.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    return await fetch(buildUrl(base, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // "include" lets the refresh cookie travel when the page and the API have different addresses (cors mode).
      credentials: "include",
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error; // the caller cancelled
    if (timeout.aborted) throw new NetworkError("timeout");
    throw new NetworkError("unreachable");
  }
}

/**
 * The ONE place that talks to the server.
 *   - 2xx with a body: the parsed JSON.   204: undefined (there is no body to parse).
 *   - the server said no:  throws ServerError (with the status).
 *   - no answer at all:    throws NetworkError ("unreachable" or "timeout").
 *   - the CALLER cancelled: the original abort error is rethrown, because that is not a failure to show.
 *   - a 401 on a signed-in call: the token is renewed ONCE and the call is tried ONCE more. A second 401 is an error.
 */
export async function request<T>(path: string, options: RequestOptions = {}, base: string = API_BASE): Promise<T> {
  const useAuth = options.auth !== false && hooks !== null;
  const firstToken = useAuth ? hooks!.getToken() : null;
  let res = await send(base, path, options, firstToken);

  if (res.status === 401 && useAuth) {
    const fresh = await hooks!.renew(firstToken);
    if (fresh) res = await send(base, path, options, fresh); // exactly one retry, never a loop
  }

  if (!res.ok) throw await toServerError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ServerError(res.status, "The server sent a reply the app could not read.");
  }
}
```

### `frontend/src/api/adapter.ts`

```ts
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
```

### `frontend/src/api/todos.ts`

```ts
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
```

### `frontend/src/session.ts` (the token in memory, renew once, sign in/up/out)

```ts
/**
 * Who is signed in, and the access token. Plain TypeScript, no React, so it can be tested alone.
 *
 * The access token lives in a variable. Not in localStorage, not in sessionStorage: a script injected into the page could read those.
 * The refresh token is an HttpOnly cookie that JavaScript cannot read at all. After a page reload the variable is empty, so the page
 * asks /auth/refresh, and the cookie (sent by the browser on its own) gets a new access token.
 */
import { request, setAuthHooks } from "./api/client";
import { ServerError } from "./api/errors";

export interface User {
  id: number;
  email: string;
  role: "viewer" | "admin";
}
export interface SessionState {
  status: "loading" | "signedOut" | "signedIn";
  user: User | null;
  /** A sentence for the sign-in page, e.g. when the session ended while the person was using the app. */
  notice: string | null;
}
interface TokenReply {
  access_token: string;
  expires_in: number;
  user: User;
}

const LOADING: SessionState = { status: "loading", user: null, notice: null };
let token: string | null = null; // memory only
let state: SessionState = LOADING;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

function setState(next: SessionState) {
  state = next;
  listeners.forEach((listener) => listener());
}
function accept(reply: TokenReply) {
  token = reply.access_token;
  setState({ status: "signedIn", user: reply.user, notice: null });
}

export const getSession = () => state;
export const getAccessToken = () => token;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function renewNow(): Promise<string | null> {
  try {
    const reply = await request<TokenReply>("/auth/refresh", { method: "POST", auth: false });
    accept(reply);
    return reply.access_token;
  } catch (error) {
    if (error instanceof ServerError && error.status === 401) {
      // The refresh cookie is missing, used, or expired: the session is really over.
      const wasSignedIn = state.status === "signedIn";
      token = null;
      setState({ status: "signedOut", user: null, notice: wasSignedIn ? "Your session ended. Please sign in again." : null });
      return null;
    }
    throw error; // no server, a timeout, a 500: the session may still be fine, so do not sign anyone out
  }
}

/**
 * Get a new access token. If several requests hit an expired token at the same moment, they all wait for ONE refresh call.
 * (Each refresh token works only once, so two refresh calls at the same time would cancel each other.)
 */
export function renewToken(failedWith: string | null): Promise<string | null> {
  // Someone already renewed while this request was in flight: use the new token, do not refresh again.
  if (token && token !== failedWith) return Promise.resolve(token);
  inflight ??= renewNow().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** On page load: try the cookie. If it works the person is signed in without typing anything. */
export async function bootstrap(): Promise<void> {
  if (state.status !== "loading") return;
  try {
    await renewToken(null);
  } catch {
    setState({ status: "signedOut", user: null, notice: null }); // the server could not be reached: show the sign-in page
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  accept(await request<TokenReply>("/auth/signin", { method: "POST", body: { email, password }, auth: false }));
}
export async function signUp(email: string, password: string): Promise<void> {
  accept(await request<TokenReply>("/auth/signup", { method: "POST", body: { email, password }, auth: false }));
}
/** Always signs out on this screen, even if the server cannot be reached. Tells the server so it can cancel the refresh token. */
export async function signOut(): Promise<void> {
  try {
    await request<void>("/auth/signout", { method: "POST", auth: false });
  } catch {
    // The token variable is cleared below either way.
  }
  token = null;
  setState({ status: "signedOut", user: null, notice: null });
}

/** For tests only. */
export function resetSession(): void {
  token = null;
  inflight = null;
  state = LOADING;
  listeners.clear();
}

setAuthHooks({ getToken: () => token, renew: renewToken });
```

### `frontend/src/messages.ts`

```ts
import { NetworkError, ServerError } from "./api/errors";

/**
 * One sentence for the person, and a DIFFERENT one for "the server said no" and "there is no server".
 * They need different actions: a server error means wait or fix the input; no server means check it is running.
 */
const NO_SERVER = "Cannot reach the server. Check that it is running, then try again.";

// 502, 503 and 504 come from a proxy standing in front of the server (the Vite dev proxy answers 502 when the backend is off).
// The browser did get an answer, but the answer means "nothing is there", so it gets the no-server sentence, not "the server had a problem".
const GATEWAY_STATUSES = [502, 503, 504];

export function describeError(error: unknown): string {
  if (error instanceof NetworkError) {
    return error.reason === "timeout" ? "The server took too long to answer. Try again in a moment." : NO_SERVER;
  }
  if (error instanceof ServerError) {
    if (GATEWAY_STATUSES.includes(error.status)) return NO_SERVER;
    if (error.status >= 500) return `The server had a problem (${error.status}). It is not your fault. Try again in a moment.`;
    const fields = Object.values(error.fieldErrors);
    if (error.status === 422) return fields.length ? fields.join(" ") : "Please check what you typed.";
    return error.message;
  }
  return "Something went wrong.";
}
```

### `frontend/src/auth/AuthProvider.tsx`

```tsx
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { bootstrap, getSession, signIn, signOut, signUp, subscribe, type SessionState } from "../session";

interface AuthValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

/** Wrap the app once. On first load it tries the refresh cookie, so a reload does not sign you out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSession);
  useEffect(() => {
    void bootstrap();
  }, []);
  const value = useMemo<AuthValue>(() => ({ ...session, signIn, signUp, signOut }), [session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}
```

### `frontend/src/auth/ProtectedRoute.tsx`

```tsx
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
```

### `frontend/src/pages/AuthForm.tsx` (sign-in and sign-up)

```tsx
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
```

### `frontend/src/pages/TodoPage.tsx` (role-aware Delete)

```tsx
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
```

### `frontend/src/App.tsx`

```tsx
import { Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import AuthForm from "./pages/AuthForm";
import TodoPage from "./pages/TodoPage";

// The router (BrowserRouter) and AuthProvider are added in main.tsx. Tests add their own.
export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<AuthForm mode="signin" />} />
      <Route path="/signup" element={<AuthForm mode="signup" />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<TodoPage />} />
      </Route>
      <Route path="*" element={<p>Page not found.</p>} />
    </Routes>
  );
}
```

### `frontend/src/main.tsx`

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

### `frontend/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>To-do</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### `frontend/src/styles.css`

```css
body { font-family: system-ui, sans-serif; margin: 0; background: #faf7f2; color: #1c1917; }
main { max-width: 640px; margin: 0 auto; padding: 16px; }
.muted { color: #57534e; }
.error { color: #b91c1c; }
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
input[type="text"], input[type="search"] { min-height: 44px; padding: 0 10px; border: 1px solid #78716c; border-radius: 8px; font: inherit; flex: 1; min-width: 160px; }
button { min-height: 44px; min-width: 44px; padding: 0 14px; border: 1px solid #78716c; border-radius: 8px; background: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
ul { list-style: none; padding: 0; }
li { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid #d6d3d1; }
li label { flex: 1; display: flex; gap: 10px; align-items: center; min-height: 44px; }
li input[type="checkbox"] { width: 22px; height: 22px; }
.done { text-decoration: line-through; color: #57534e; }
.stack { display: grid; gap: 8px; max-width: 360px; }
input[type="email"], input[type="password"] { min-height: 44px; padding: 0 10px; border: 1px solid #78716c; border-radius: 8px; font: inherit; }
header.row h1 { flex: 1; margin: 0; }
```

### `frontend/scripts/check-browser.mjs` (real browser, real backend, the four numbers)

```js
// Real-browser proof for sign-in. Starts the real FastAPI backend and the real Vite dev server, drives Chromium, and measures the four
// things that matter. The backend runs with a 3 second access token so "expired" happens fast.
//
// Run:  npm run proof      (needs: backend dependencies installed, and  npx playwright install chromium)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const backendDir = path.resolve(root, "..", "backend");
const shots = path.join(root, "proof");
mkdirSync(shots, { recursive: true });
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const work = mkdtempSync(path.join(tmpdir(), "todo-auth-proof-"));
const logFile = path.join(work, "backend.log");
const ADMIN = "admin@example.com";
const PASSWORD = "correct horse battery";
const numbers = {};

const children = [];
const results = [];
let failed = 0;
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isApi = (url) => new URL(url).pathname.startsWith("/api/"); // not "/src/api/..." source files

async function waitFor(url, what) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`${what} did not start (${url})`);
}
function startBackend(dbName) {
  writeFileSync(logFile, "");
  const p = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", "8000"], {
    cwd: backendDir,
    env: {
      ...process.env,
      TODO_DB: path.join(work, dbName),
      JWT_SECRET: "proof-secret-that-is-long-enough-0123456789abcdef",
      ACCESS_TTL_SECONDS: "3", // a very short token life while testing
      ADMIN_EMAILS: ADMIN,
    },
  });
  const append = (d) => writeFileSync(logFile, readFileSync(logFile) + d.toString());
  p.stdout.on("data", append);
  p.stderr.on("data", append);
  children.push(p);
  return p;
}
function startVite(mode) {
  const args = [path.join(root, "node_modules", "vite", "bin", "vite.js")];
  if (mode) args.push("--mode", mode);
  const p = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "ignore" });
  children.push(p);
  return p;
}
const stop = (p) => new Promise((resolve) => (p.exitCode !== null ? resolve() : (p.once("exit", resolve), p.kill())));
/** Lines the BACKEND logged, e.g. 'POST /api/auth/refresh HTTP/1.1" 200'. */
const logLines = () => readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('HTTP/1.1"'));
const count = (pattern) => logLines().filter((l) => pattern.test(l)).length;

async function api(base, method, route, { token, body, cookie } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 700, height: 560 } });
  const page = await context.newPage();
  const sent = [];
  page.on("request", async (r) => isApi(r.url()) && sent.push({ method: r.method(), url: new URL(r.url()), headers: await r.allHeaders() }));
  return { context, page, sent };
}
async function uiSignUp(page, base, email) {
  await page.goto(`${base}/signup`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("who").waitFor();
}
async function uiSignIn(page, base, email, password = PASSWORD) {
  await page.goto(`${base}/signin`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
/** Three list calls at the same moment, through the app's own API layer, after the 3 second token has expired. */
async function threeCallsOnAnExpiredToken(page, sent) {
  await page.waitForTimeout(4500); // access token life is 3 seconds
  const refreshBefore = count(/POST \/api\/auth\/refresh HTTP\/1.1" 200/);
  const eventsBefore = sent.filter((s) => s.url.pathname === "/api/auth/refresh").length;
  const lengths = await page.evaluate(async () => {
    const todos = await import("/src/api/todos.ts");
    const all = await Promise.all([todos.listTodos(), todos.listTodos(), todos.listTodos()]);
    return all.map((x) => x.length);
  });
  return {
    lengths,
    logged: count(/POST \/api\/auth\/refresh HTTP\/1.1" 200/) - refreshBefore,
    events: sent.filter((s) => s.url.pathname === "/api/auth/refresh").length - eventsBefore,
  };
}
async function storageReport(page, secret) {
  return page.evaluate(async (token) => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    const all = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]);
    return {
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length,
      documentCookie: document.cookie,
      indexedDB: dbs.length,
      tokenAnywhere: token ? all.includes(token) : null,
    };
  }, secret);
}

let browser;
try {
  browser = await chromium.launch();

  // ============================================================== MODE 1: DEV PROXY
  console.log("\n== Mode 1: dev proxy (npm run dev). Same address for page and API. ==");
  let backend = startBackend("proxy.db");
  let vite = startVite(undefined);
  await waitFor("http://localhost:8000/docs", "backend");
  await waitFor("http://localhost:5173/", "vite");
  const base = "http://localhost:5173";
  {
    // an admin (made by the server because of ADMIN_EMAILS) puts three to-dos in the list
    const admin = await api(`${base}/api`, "POST", "/auth/signup", { body: { email: ADMIN, password: PASSWORD } });
    check("the server made the admin from its own list (201, role admin)", admin.status === 201 && admin.json.user.role === "admin");
    for (const title of ["Buy milk", "Call mum", "Pay rent"]) await api(`${base}/api`, "POST", "/todos", { token: admin.json.access_token, body: { title } });

    const { context, page, sent } = await newPage(browser);
    await uiSignUp(page, base, "viewer@example.com");
    await page.getByText("Buy milk").waitFor();
    check("a new sign-up is a viewer, and sees the list", (await page.getByTestId("who").innerText()).includes("(viewer)"));
    check("a viewer sees no Delete buttons", (await page.getByRole("button", { name: /^Delete/ }).count()) === 0);
    await page.screenshot({ path: path.join(shots, "1-viewer.png") });

    // ---- NUMBER 2: the cookie's flags, as the browser stored them
    const cookie = (await context.cookies()).find((c) => c.name === "refresh_token");
    const days = cookie ? (cookie.expires - Date.now() / 1000) / 86400 : 0;
    numbers.cookie = cookie && { name: cookie.name, httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite, secure: cookie.secure, expiresInDays: Number(days.toFixed(2)) };
    console.log("      stored cookie:", JSON.stringify(numbers.cookie));
    check("cookie: HttpOnly", cookie?.httpOnly === true);
    check("cookie: Path is /api/auth (narrow)", cookie?.path === "/api/auth", cookie?.path);
    check("cookie: SameSite is Strict (explicit)", cookie?.sameSite === "Strict", cookie?.sameSite);
    check("cookie: Secure is off on plain http://localhost (it is on in production)", cookie?.secure === false);
    check("cookie lasts about 7 days", days > 6.9 && days < 7.1, `${days.toFixed(2)} days`);

    // ---- NUMBER 4: what is in storage and document.cookie
    const token = await page.evaluate(async () => (await import("/src/session.ts")).getAccessToken());
    const store = await storageReport(page, token);
    numbers.storage = store;
    console.log("      storage:", JSON.stringify({ ...store, tokenAnywhere: store.tokenAnywhere }));
    check("localStorage is empty (0 items)", store.localStorage === 0);
    check("sessionStorage is empty (0 items)", store.sessionStorage === 0);
    check("document.cookie is empty: JavaScript cannot see the refresh cookie", store.documentCookie === "", JSON.stringify(store.documentCookie));
    check("the access token is not in storage or document.cookie", store.tokenAnywhere === false);
    check("no IndexedDB databases", store.indexedDB === 0);
    check("the access token exists, in a variable", typeof token === "string" && token.split(".").length === 3);

    // the cookie travels only to /api/auth
    const todoCall = sent.find((s) => s.method === "GET" && s.url.pathname === "/api/todos");
    check("the cookie is NOT sent with a to-do request", todoCall && !("cookie" in todoCall.headers));
    check("the to-do request carries the Bearer token instead", todoCall?.headers.authorization?.startsWith("Bearer "));

    // a reload empties the variable. The cookie signs the person in again
    await page.reload();
    await page.getByTestId("who").waitFor();
    const refreshCall = sent.filter((s) => s.url.pathname === "/api/auth/refresh").at(-1);
    check("after a reload the person is still signed in (cookie -> refresh)", true);
    check("the refresh call carried the cookie", refreshCall && String(refreshCall.headers.cookie).includes("refresh_token="));

    // ---- NUMBER 1: three requests meet an expired token
    const three = await threeCallsOnAnExpiredToken(page, sent);
    numbers.threeRequestsOnExpiredToken = { refreshCallsInBackendLog: three.logged, refreshRequestsSeenByBrowser: three.events, allThreeSucceeded: three.lengths };
    console.log(`      3 requests on an expired token -> refresh calls: backend log ${three.logged}, browser ${three.events}; results ${three.lengths}`);
    check("three requests on an expired token: all three succeed", three.lengths.length === 3 && three.lengths.every((n) => n === 3), three.lengths.join());
    check("three requests on an expired token: exactly 1 refresh call (backend log)", three.logged === 1, `${three.logged}`);
    check("three requests on an expired token: exactly 1 refresh call (browser)", three.events === 1, `${three.events}`);

    // ---- NUMBER 3: a viewer sends DELETE by hand
    const viewerToken = await page.evaluate(async () => (await import("/src/session.ts")).getAccessToken());
    const del = await page.evaluate(async (t) => (await fetch("/api/todos/1", { method: "DELETE", headers: { Authorization: `Bearer ${t}` } })).status, viewerToken);
    const delBody = await page.evaluate(async (t) => (await (await fetch("/api/todos/1", { method: "DELETE", headers: { Authorization: `Bearer ${t}` } })).json()).detail, viewerToken);
    const delNone = await page.evaluate(async () => (await fetch("/api/todos/1", { method: "DELETE" })).status);
    const stillThere = await api(`${base}/api`, "GET", "/todos/1", { token: viewerToken });
    const adminNow = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: ADMIN, password: PASSWORD } }); // a fresh token: the first one is 3 seconds old by now
    const adminDelete = await api(`${base}/api`, "DELETE", "/todos/3", { token: adminNow.json.access_token });
    numbers.deleteByHand = { viewer: del, noToken: delNone, admin: adminDelete.status };
    console.log(`      DELETE by hand -> viewer ${del}, no token ${delNone}, admin ${adminDelete.status}`);
    check("a viewer's DELETE by hand: 403", del === 403, `${del}`);
    check("the 403 says why", delBody === "Only an admin can do that.", delBody);
    check("DELETE with no token: 401", delNone === 401, `${delNone}`);
    check("the refused delete changed nothing", stillThere.status === 200);
    check("an admin's DELETE: 204", adminDelete.status === 204, `${adminDelete.status}`);

    // the admin sees Delete buttons
    const adminCtx = await newPage(browser);
    await uiSignIn(adminCtx.page, base, ADMIN);
    await adminCtx.page.getByRole("button", { name: /^Delete/ }).first().waitFor();
    check("an admin sees Delete buttons", (await adminCtx.page.getByRole("button", { name: /^Delete/ }).count()) >= 1);
    await adminCtx.page.screenshot({ path: path.join(shots, "2-admin.png") });
    await adminCtx.context.close();

    // wrong email and wrong password look identical
    const wrong = await newPage(browser);
    await uiSignIn(wrong.page, base, "viewer@example.com", "not the password");
    const a = await wrong.page.getByRole("alert").innerText();
    await uiSignIn(wrong.page, base, "nobody@example.com", PASSWORD);
    const b = await wrong.page.getByRole("alert").innerText();
    const rawA = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: "viewer@example.com", password: "nope nope nope" } });
    const rawB = await api(`${base}/api`, "POST", "/auth/signin", { body: { email: "nobody@example.com", password: "nope nope nope" } });
    check("wrong password and wrong email: the same sentence on screen", a === b && a === "Wrong email or password.", `${a} / ${b}`);
    check("wrong password and wrong email: the same status and body from the server", rawA.status === rawB.status && JSON.stringify(rawA.json) === JSON.stringify(rawB.json));
    await wrong.page.screenshot({ path: path.join(shots, "3-wrong-login.png") });
    await wrong.context.close();

    // sign out: cookie gone, and a copy of the old cookie is dead on the server
    const oldCookie = `refresh_token=${(await context.cookies()).find((c) => c.name === "refresh_token").value}`;
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    const after = (await context.cookies()).find((c) => c.name === "refresh_token");
    const replay = await api(`${base}/api`, "POST", "/auth/refresh", { cookie: oldCookie });
    check("sign out: the browser's cookie is gone", after === undefined);
    check("sign out: a copy of the old cookie no longer works (401)", replay.status === 401, `${replay.status}`);
    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    check("after sign out, the protected page sends you to sign in", true);
    await page.screenshot({ path: path.join(shots, "4-signed-out.png") });
    await context.close();
  }
  await stop(backend);
  await stop(vite);

  // ============================================================== MODE 2: CORS
  console.log("\n== Mode 2: cross-origin (npm run dev:cors). Page :5173, API :8000. The cookie must cross with credentials. ==");
  backend = startBackend("cors.db");
  vite = startVite("cors");
  await waitFor("http://localhost:8000/docs", "backend");
  await waitFor("http://localhost:5173/", "vite");
  {
    const admin = await api("http://localhost:8000/api", "POST", "/auth/signup", { body: { email: ADMIN, password: PASSWORD } });
    for (const title of ["Buy milk", "Call mum"]) await api("http://localhost:8000/api", "POST", "/todos", { token: admin.json.access_token, body: { title } });
    const { context, page, sent } = await newPage(browser);
    await uiSignUp(page, "http://localhost:5173", "viewer@example.com");
    await page.getByText("Buy milk").waitFor();
    check("cors mode: sign-up and the list work across origins", sent.every((s) => s.url.host === "localhost:8000"), [...new Set(sent.map((s) => s.url.host))].join());
    const cookie = (await context.cookies()).find((c) => c.name === "refresh_token");
    check("cors mode: the cookie was accepted from the other origin, with the same flags", cookie?.httpOnly && cookie.path === "/api/auth" && cookie.sameSite === "Strict", JSON.stringify(cookie && { httpOnly: cookie.httpOnly, path: cookie.path, sameSite: cookie.sameSite }));
    await page.reload();
    await page.getByTestId("who").waitFor();
    check("cors mode: after a reload the cookie signs the person in again (credentials: include works)", true);
    const three = await threeCallsOnAnExpiredToken(page, sent);
    check("cors mode: three requests on an expired token make exactly 1 refresh call", three.logged === 1 && three.events === 1 && three.lengths.every((n) => n === 2), `log ${three.logged}, browser ${three.events}`);
    const store = await storageReport(page, null);
    check("cors mode: storage and document.cookie are empty", store.localStorage === 0 && store.sessionStorage === 0 && store.documentCookie === "");
    const preflights = logLines().filter((l) => l.includes('"OPTIONS ')).map((l) => l.match(/"OPTIONS ([^ ]+)/)[1]);
    numbers.corsPreflightsSeenInBackendLog = [...new Set(preflights)];
    console.log("      preflights the backend saw (distinct addresses):", numbers.corsPreflightsSeenInBackendLog.join(" "));
    check("cors mode: the Authorization header made the browser preflight the to-do calls", preflights.includes("/api/todos"));
    await page.screenshot({ path: path.join(shots, "5-cors-mode.png") });
    await context.close();
  }
  await stop(vite);
} finally {
  for (const c of children) c.exitCode === null && c.kill();
  if (browser) await browser.close();
  writeFileSync(path.join(shots, "proof-numbers.json"), JSON.stringify(numbers, null, 2));
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots and numbers are in frontend/proof/`);
process.exit(failed ? 1 : 0);
```

### `break42.py` (break each rule once on purpose)

```python
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
```

### Design decisions

| Decision | Reason |
|---|---|
| Argon2id through `argon2-cffi` with the library's recommended cost | It is memory-hard, so guessing passwords on many machines is expensive. A test pins the default cost (3 passes, 64 MB) so nobody turns it down by accident. Tests use a cheap setting (`fast_hash`) only so 100 sign-ups do not take a minute. |
| A random salt per password (built into Argon2) | Two people with the same password get different hashes. A test checks it. |
| Passwords are never trimmed or changed, 8 to 128 characters | Spaces may be part of a password. The upper limit stops someone sending a 10 MB "password" to make the server hash it. |
| The access token is an HS256 JWT with only `sub`, `role`, `iat`, `exp` | No email, no password, nothing secret. A test lists the exact claims. |
| Access token life is 300 seconds and comes from `ACCESS_TTL_SECONDS` | "A few minutes" by default, and 3 seconds in the browser check so expiry is quick to test. |
| `algorithms=["HS256"]` and `require: [exp, sub]` on every decode | A token with no expiry, `alg: none`, another algorithm, another secret, or a changed payload is a 401. Six tests. |
| An expired token has its own message ("Your session expired.") | Both kinds are a 401, so the page renews either way. The words help when debugging in `/docs`. |
| The role is read from the database on each request | A demotion or a deleted user takes effect on the next call. A forged token that claims admin does not make anyone an admin. |
| Roles are `viewer` or `admin`, chosen by the server from `ADMIN_EMAILS` | The sign-up body has `extra="forbid"`, so `{"role": "admin"}` is a 422. The admin list is an environment variable, so there is no public way to become an admin. |
| A viewer can read, add and tick off to-dos; only an admin can delete | The task says a viewer can read and only an admin can delete. It does not say what a viewer may add or change, so deletion is the only locked action. If viewers must be read-only, change two dependencies in `main.py`. |
| 401 is checked before 404 and before 422 | A signed-out person must learn nothing about which to-dos exist or what the body rules are. A test checks both orders. |
| A viewer's DELETE of an id that does not exist is still 403 | No hint about what exists. |
| The refresh token is 48 random bytes, stored only as a SHA-256 hash | A leaked database does not leak working tokens. SHA-256 is fine here (unlike for passwords) because the value is long and random. |
| Each refresh token works once; an old one coming back cancels all of that user's sessions | Rotation makes a stolen cookie short-lived, and replay detection turns a copy into an alarm. |
| Cookie: `HttpOnly`, `Path=/api/auth`, `SameSite=Strict`, `Max-Age` 7 days, `Secure` by setting | Each flag is written out, and a test checks each one. `Secure` is a setting because browsers on other machines will not store it from plain http. |
| The clearing cookie uses the same `Path` and flags as the real one | A cookie is identified by name, domain and path. A delete with a different path would leave the real cookie in place. |
| A refused refresh returns a response instead of raising an error | Found by a test: when FastAPI raises an error, the cookie header set on the response is thrown away, so the dead cookie would never be cleared. |
| Sign-in always runs the password check, against a dummy hash when the email is unknown | The same amount of work for both failures, so timing does not show which emails exist. A test counts the checks. |
| Sign-up with a taken email is a 409 with a clear sentence | This does reveal that the email has an account. The task asks for one message on sign-IN. For sign-up, telling the person is the usable choice. It is listed as a known limit. |
| Sign-out always answers 204 and always clears the cookie | Signing out must work even when the session is already dead. The access token stays valid until it expires (a test documents this); the short life is the protection. |
| `CORSMiddleware` with `allow_credentials=True`, `Authorization` allowed, exact origins | Credentials cannot be combined with `*`. The cookie only crosses origins when the server says so. |
| The access token lives in a module variable in `session.ts` | Not in `localStorage` or `sessionStorage`, which any injected script can read. After a reload the variable is empty and the cookie brings it back. |
| `session.ts` has no React in it | The hard part (renew once, single flight) is plain code that can be tested alone. `AuthProvider` only shows it to React with `useSyncExternalStore`. |
| `client.ts` takes `setAuthHooks({ getToken, renew })` | The API layer does not know how tokens are stored. `session.ts` plugs itself in. Calls under `/auth` pass `auth: false`, so they never carry a token and never trigger a renewal. |
| Exactly one retry after a 401, never a loop | A second 401 is a real answer. A test gives a server that always says 401 and counts exactly two to-do requests and one refresh. |
| `credentials: "include"` on every call | Needed so the refresh cookie travels in cross-origin mode. The browser check proves it in both modes. |
| `renewToken(failedWith)` returns the current token if it is not the one that failed | A late 401 after a renewal must not cause a second refresh. Rotation would make it dangerous, not just wasteful. |
| A refresh that fails with 500 or no network does not sign anyone out | Only a 401 from refresh means the session is over. A server hiccup should not throw a signed-in person away. |
| `ProtectedRoute` shows "Checking your session…" while the cookie is tried | Redirecting too early would flash the sign-in page for a person who is actually signed in. A test checks there is no flash. |
| After sign-in the person goes back to the page they asked for | The route remembers `from` in the navigation state. |
| One `AuthForm` for sign-in and sign-up | The two pages differ in words, in the action, and in the `autocomplete` value (`current-password` or `new-password`), which lets password managers do the right thing. |
| The form has `noValidate` and shows the server's message | Browser pop-ups would hide the server's own sentence. The server is the one authority on what a valid email or password is. |
| The Delete button is hidden for viewers | A courtesy only. The server's 403 is the protection, and a test clicks the button after a role change to prove it. |
| A "Your session ended" notice when a refresh is refused mid-use | So a person thrown back to sign-in knows why. A normal sign-out shows no such notice. |
| The proof script runs the backend with a 3 second token, a fixed secret and an admin list | It makes expiry happen in seconds, and makes the results repeatable. |
| The proof script imports the app's own API module in the page (`import("/src/api/todos.ts")`) | The three simultaneous requests go through exactly the same `request` function the app uses, not a copy. |

---

## 7. Tests (311 tests)

The backend has 186 tests and the frontend 125. The 75 Day 41 backend tests are unchanged: the `client` fixture now signs up an admin and carries its token, so they run as before. The frontend tests use a fake sign-in server (MSW) that can expire the token, refuse the refresh, slow the refresh down, change the role and count every refresh and sign-out call. On top of that, `scripts/check-browser.mjs` runs everything for real in Chromium, and `break42.py` checks that the tests notice 38 deliberate mistakes.

| # | Test | What it proves |
|---|---|---|
| backend/tests/test_auth.py (90) | Sign-up (201, no password or hash in the response, email trimmed and lowercased, duplicate in another case is 409, 6 bad emails and 3 short passwords are 422, a 129-character password is refused, the client cannot send a role, the server picks the role from its list, look-alike addresses are not admins). Password storage (an `$argon2id$` hash, different hashes for the same password, spaces kept, default cost pinned). Sign-in (200, case-insensitive email, a wrong email and a wrong password give exactly the same status and body, an unknown email still runs the password check, no cookie on failure, two sessions are independent). The cookie (HttpOnly, narrow path, SameSite, 7 days, no Secure by default, Secure when told, random, sent to `/api/auth` and never to `/api/todos`, only a hash stored). The access token (HS256, 5 minutes, exact claims, expired, wrong secret, `alg: none`, wrong algorithm, tampered payload, no expiry, garbage, role from the database, deleted user). Who can do what (every route is 401 without a token or with a garbage token, wrong scheme, 401 before 404 and 422, a viewer can read, add and tick, a viewer's delete is 403 and changes nothing, even for an id that does not exist, an admin's delete is 204, `/me`). Refresh (new token and rotated cookie, the new token works, no cookie, made-up cookie clears it, expired, works once, replay cancels the session, deleted user). Sign-out (204, cookie cleared with the same path, the token is dead on the server, works when signed out, leaves other sessions alone, the access token still works until it expires). Settings from environment variables | Backend auth |
| backend/tests/test_api.py (75) | The Day 41 contract (list, filter, search, create, get, PATCH, DELETE, trailing slash, OpenAPI, persistence, SQL safety), now as a signed-in admin | Backend contract |
| backend/tests/test_cors.py (21) | The 16 Day 41 CORS tests, plus: `Authorization` is allowed in a preflight; credentials are allowed so the cookie can travel; the allow-origin is the exact page, never a star; a refused refresh still carries the CORS headers so the page can read the 401; a stranger gets no allow-origin | CORS |
| frontend/src/session.test.ts (24) | Sign-in keeps the token in memory; nothing in `localStorage`, `sessionStorage` or `document.cookie`; a wrong password is a 401 with the server's sentence and does not start a refresh; a wrong email gives the same error; the Bearer header is added; sign-in calls carry none; `credentials: include` on every call; an expired token is renewed and the call retried; **three calls at once make one refresh**; a 401 that arrives after the renewal does not refresh again; a second 401 is an error with no loop; a refused refresh signs the person out with a notice; no server or a 500 during refresh does not; `/auth` calls never refresh; `renewToken` called twice shares one call; the page-load cookie check (works, no cookie, no server); sign-out (tells the server, still works when the server is down); a viewer's DELETE is a 403 with the server's sentence, a 403 does not refresh, an admin can | Session |
| frontend/src/auth/auth-ui.test.tsx (22) | Sign-in page (labels, hidden password, `autocomplete`, a good sign-in lands on the list, the same sentence for a wrong password and a wrong email, no-server sentence, button state, already signed in is sent on). Sign-up page (creates a viewer, a taken email, a short password shows the server's message, **the form never sends a role**). Protected page (the checking message and no flash, redirect, back to the wanted page, StrictMode makes one refresh call). Roles on screen (no Delete for a viewer, Delete for an admin, a demoted admin gets the server's 403 and the row stays). While using it (an expired token is renewed behind the scenes, a dead session lands on sign-in with a reason, Sign out, cannot go back, nothing left in storage) | Screens |
| frontend/src/pages/TodoPage.test.tsx (23) | The Day 41 screen tests (loading, errors, add, toggle, delete, search, filter, cancelling old requests), now inside the signed-in app | To-do screen |
| frontend/src/api/client.test.ts (29), adapter.test.ts (9), env.test.ts (8) | The Day 41 API layer, adapter and environment tests, unchanged in meaning | API layer |
| frontend/src/messages.test.ts (10) | The Day 41 messages, plus 401, 403 and 409 show the server's own sentence | Messages |

### `backend/tests/conftest.py`

```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

ADMIN = "admin@example.com"
PASSWORD = "correct horse battery"


def make_settings(**changes) -> Settings:
    base = dict(jwt_secret="test-secret-that-is-long-enough-for-hs256-0123456789", fast_hash=True, admin_emails=frozenset({ADMIN}))
    base.update(changes)
    return Settings(**base)


def new_app_client(tmp_path, name="test.db", **changes) -> TestClient:
    return TestClient(create_app(str(tmp_path / name), make_settings(**changes)))


def sign_up(client: TestClient, email: str, password: str = PASSWORD):
    return client.post("/api/auth/signup", json={"email": email, "password": password})


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def anon(tmp_path):
    """A fresh server with its own empty database file. Nobody is signed in."""
    return new_app_client(tmp_path)


@pytest.fixture()
def client(anon):
    """The same server, with an ADMIN signed in. The Day 41 tests use this, so they run unchanged."""
    token = sign_up(anon, ADMIN).json()["access_token"]
    anon.headers.update(bearer(token))
    return anon


@pytest.fixture()
def make(client):
    def _make(title="Buy milk"):
        return client.post("/api/todos", json={"title": title}).json()

    return _make


@pytest.fixture()
def viewer_token(anon):
    return sign_up(anon, "viewer@example.com").json()["access_token"]
```

### `backend/tests/test_auth.py`

```python
import sqlite3
import time

import jwt
import pytest

from app import auth as auth_module
from app.settings import Settings

from .conftest import ADMIN, PASSWORD, bearer, make_settings, new_app_client, sign_up

SECRET = make_settings().jwt_secret


def cookie_header(res) -> str:
    return res.headers.get("set-cookie", "")


def forge(claims: dict, secret: str = SECRET, algorithm: str = "HS256") -> str:
    return jwt.encode(claims, secret, algorithm=algorithm)


class TestSignUp:
    def test_201_with_a_token_and_the_user(self, anon):
        res = sign_up(anon, "sam@example.com")
        assert res.status_code == 201
        body = res.json()
        assert body["token_type"] == "bearer" and body["access_token"]
        assert body["user"] == {"id": 1, "email": "sam@example.com", "role": "viewer"}

    def test_the_response_never_contains_the_password_or_its_hash(self, anon):
        text = sign_up(anon, "sam@example.com").text
        assert PASSWORD not in text and "argon2" not in text

    def test_the_email_is_trimmed_and_lowercased(self, anon):
        assert sign_up(anon, "  Sam@Example.COM ").json()["user"]["email"] == "sam@example.com"

    def test_the_same_email_twice_is_409_even_in_another_case(self, anon):
        sign_up(anon, "sam@example.com")
        res = sign_up(anon, "SAM@example.com")
        assert res.status_code == 409
        assert "already registered" in res.json()["detail"]

    @pytest.mark.parametrize("email", ["", "no-at-sign", "a@b", "a b@c.com", "@c.com", "a@" + "x" * 260 + ".com"])
    def test_a_bad_email_is_422(self, anon, email):
        assert sign_up(anon, email).status_code == 422

    @pytest.mark.parametrize("password", ["", "short", "1234567"])
    def test_a_short_password_is_422(self, anon, password):
        assert sign_up(anon, "sam@example.com", password).status_code == 422

    def test_a_very_long_password_is_refused(self, anon):
        assert sign_up(anon, "sam@example.com", "x" * 129).status_code == 422

    def test_the_client_cannot_choose_its_role(self, anon):
        res = anon.post("/api/auth/signup", json={"email": "sam@example.com", "password": PASSWORD, "role": "admin"})
        assert res.status_code == 422

    def test_the_server_decides_the_role_from_its_own_list(self, anon):
        assert sign_up(anon, ADMIN).json()["user"]["role"] == "admin"
        assert sign_up(anon, "sam@example.com").json()["user"]["role"] == "viewer"

    def test_an_email_that_only_looks_like_the_admin_is_not_an_admin(self, anon):
        assert sign_up(anon, "admin@example.com.evil.io").json()["user"]["role"] == "viewer"
        assert sign_up(anon, "xadmin@example.com").json()["user"]["role"] == "viewer"

    def test_wrong_types_are_refused(self, anon):
        assert anon.post("/api/auth/signup", json={"email": 5, "password": PASSWORD}).status_code == 422
        assert anon.post("/api/auth/signup", json={"email": "a@b.co"}).status_code == 422


class TestPasswordStorage:
    def stored(self, tmp_path, email):
        with sqlite3.connect(tmp_path / "test.db") as conn:
            return conn.execute("SELECT password_hash FROM users WHERE email = ?", (email,)).fetchone()[0]

    def test_it_is_an_argon2id_hash_and_not_the_password(self, tmp_path):
        client = new_app_client(tmp_path)
        sign_up(client, "sam@example.com")
        stored = self.stored(tmp_path, "sam@example.com")
        assert stored.startswith("$argon2id$")
        assert PASSWORD not in stored

    def test_the_same_password_gives_a_different_hash_for_each_user(self, tmp_path):
        client = new_app_client(tmp_path)
        sign_up(client, "a@example.com")
        sign_up(client, "b@example.com")
        assert self.stored(tmp_path, "a@example.com") != self.stored(tmp_path, "b@example.com")  # a random salt each time

    def test_spaces_in_a_password_are_kept(self, anon):
        sign_up(anon, "sam@example.com", "  spaced out  ")
        assert anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": "  spaced out  "}).status_code == 200
        assert anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": "spaced out"}).status_code == 401

    def test_the_default_cost_is_the_libraries_recommended_one(self):
        from app.security import make_hasher

        hasher = make_hasher(Settings())
        assert (hasher.time_cost, hasher.memory_cost) == (3, 65536)


class TestSignIn:
    def test_200_with_a_token(self, anon):
        sign_up(anon, "sam@example.com")
        res = anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": PASSWORD})
        assert res.status_code == 200 and res.json()["access_token"]

    def test_the_email_is_not_case_sensitive(self, anon):
        sign_up(anon, "sam@example.com")
        assert anon.post("/api/auth/signin", json={"email": " SAM@Example.com ", "password": PASSWORD}).status_code == 200

    def test_a_wrong_email_and_a_wrong_password_give_exactly_the_same_answer(self, anon):
        sign_up(anon, "sam@example.com")
        wrong_password = anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": "not the password"})
        wrong_email = anon.post("/api/auth/signin", json={"email": "nobody@example.com", "password": PASSWORD})
        assert wrong_password.status_code == wrong_email.status_code == 401
        assert wrong_password.json() == wrong_email.json() == {"detail": "Wrong email or password."}

    def test_an_unknown_email_still_does_the_password_check(self, anon, monkeypatch):
        """Both failures must take the same work, or the time taken would tell an attacker which emails exist."""
        calls = []
        real = auth_module.verify_password
        monkeypatch.setattr(auth_module, "verify_password", lambda *a: calls.append(a) or real(*a))
        anon.post("/api/auth/signin", json={"email": "nobody@example.com", "password": PASSWORD})
        assert len(calls) == 1

    def test_missing_fields_are_422(self, anon):
        assert anon.post("/api/auth/signin", json={"email": "a@b.co"}).status_code == 422

    def test_a_failed_sign_in_sets_no_cookie_and_no_token(self, anon):
        res = anon.post("/api/auth/signin", json={"email": "nobody@example.com", "password": PASSWORD})
        assert "set-cookie" not in res.headers and "access_token" not in res.text

    def test_two_sign_ins_are_two_independent_sessions(self, anon):
        sign_up(anon, "sam@example.com")
        first = anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": PASSWORD})
        cookie_one = anon.cookies.get("refresh_token")
        anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": PASSWORD})
        anon.cookies.clear()
        anon.cookies.set("refresh_token", cookie_one, path="/api/auth")
        assert first.status_code == 200
        assert anon.post("/api/auth/refresh").status_code == 200  # signing in a second time did not cancel the first


class TestTheRefreshCookie:
    @pytest.fixture()
    def flags(self, anon):
        return cookie_header(sign_up(anon, "sam@example.com"))

    def test_it_is_http_only(self, flags):
        assert "HttpOnly" in flags

    def test_its_path_is_narrow(self, flags):
        assert "Path=/api/auth" in flags and "Path=/;" not in flags

    def test_samesite_is_stated_not_left_to_the_browser(self, flags):
        assert "SameSite=strict" in flags

    def test_it_lasts_as_long_as_the_refresh_token(self, flags):
        assert "Max-Age=604800" in flags

    def test_it_is_not_secure_on_plain_http_by_default(self, flags):
        assert "Secure" not in flags

    def test_it_is_secure_when_the_server_is_told_it_is_on_https(self, tmp_path):
        client = new_app_client(tmp_path, cookie_secure=True)
        assert "Secure" in cookie_header(sign_up(client, "sam@example.com"))

    def test_the_value_is_a_long_random_string(self, anon):
        sign_up(anon, "a@example.com")
        one = anon.cookies.get("refresh_token")
        sign_up(anon, "b@example.com")
        assert one != anon.cookies.get("refresh_token") and len(one) >= 48

    def test_the_browser_sends_it_to_the_auth_routes_and_never_to_the_to_do_routes(self, anon):
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        todos = anon.get("/api/todos", headers=bearer(token))
        refresh = anon.post("/api/auth/refresh")
        assert todos.request.headers.get("cookie") is None
        assert "refresh_token=" in refresh.request.headers.get("cookie", "")

    def test_only_a_hash_is_stored(self, tmp_path):
        client = new_app_client(tmp_path)
        sign_up(client, "sam@example.com")
        raw = client.cookies.get("refresh_token")
        with sqlite3.connect(tmp_path / "test.db") as conn:
            rows = [r[0] for r in conn.execute("SELECT token_hash FROM refresh_tokens")]
        assert rows and raw not in rows and all(len(r) == 64 for r in rows)


class TestTheAccessToken:
    def test_it_is_a_signed_hs256_token_with_the_short_life(self, anon):
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        assert jwt.get_unverified_header(token)["alg"] == "HS256"
        claims = jwt.decode(token, SECRET, algorithms=["HS256"])
        assert claims["exp"] - claims["iat"] == 300  # five minutes
        assert claims["sub"] == "1"

    def test_expires_in_matches(self, anon):
        assert sign_up(anon, "sam@example.com").json()["expires_in"] == 300

    def test_it_carries_no_password_or_email(self, anon):
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        claims = jwt.decode(token, SECRET, algorithms=["HS256"])
        assert set(claims) == {"sub", "role", "iat", "exp"}

    def test_an_expired_token_is_401_with_its_own_message(self, tmp_path):
        client = new_app_client(tmp_path, access_ttl_seconds=-10)
        token = sign_up(client, "sam@example.com").json()["access_token"]
        res = client.get("/api/todos", headers=bearer(token))
        assert res.status_code == 401 and res.json()["detail"] == "Your session expired."

    def test_a_token_signed_with_another_secret_is_401(self, anon):
        sign_up(anon, "sam@example.com")
        token = forge({"sub": "1", "role": "viewer", "exp": int(time.time()) + 60}, secret="x" * 40)
        assert anon.get("/api/todos", headers=bearer(token)).status_code == 401

    def test_a_token_with_alg_none_is_401(self, anon):
        sign_up(anon, "sam@example.com")
        token = jwt.encode({"sub": "1", "role": "admin", "exp": int(time.time()) + 60}, key=None, algorithm="none")
        assert anon.get("/api/todos", headers=bearer(token)).status_code == 401

    @pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")
    def test_a_token_signed_with_the_right_secret_but_another_algorithm_is_401(self, anon):
        sign_up(anon, "sam@example.com")
        token = forge({"sub": "1", "role": "admin", "exp": int(time.time()) + 60}, algorithm="HS512")
        assert anon.get("/api/todos", headers=bearer(token)).status_code == 401

    def test_a_tampered_payload_is_401(self, anon):
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        head, _, sig = token.split(".")
        evil = jwt.utils.base64url_encode(b'{"sub":"1","role":"admin","exp":9999999999}').decode()
        assert anon.get("/api/todos", headers=bearer(f"{head}.{evil}.{sig}")).status_code == 401

    def test_a_token_with_no_expiry_is_401(self, anon):
        sign_up(anon, "sam@example.com")
        assert anon.get("/api/todos", headers=bearer(forge({"sub": "1"}))).status_code == 401

    def test_garbage_is_401(self, anon):
        assert anon.get("/api/todos", headers=bearer("not.a.token")).status_code == 401

    def test_the_role_comes_from_the_database_not_from_the_token(self, anon):
        """A correctly signed token that CLAIMS admin must not make a viewer an admin."""
        sign_up(anon, "sam@example.com")
        token = forge({"sub": "1", "role": "admin", "exp": int(time.time()) + 60})
        anon.headers.update(bearer(token))
        assert anon.post("/api/todos", json={"title": "x"}).status_code == 201
        assert anon.delete("/api/todos/1").status_code == 403

    def test_a_token_for_a_user_that_no_longer_exists_is_401(self, anon):
        assert anon.get("/api/todos", headers=bearer(forge({"sub": "99", "role": "admin", "exp": int(time.time()) + 60}))).status_code == 401


class TestWhoCanDoWhat:
    ROUTES = [("GET", "/api/todos"), ("POST", "/api/todos"), ("GET", "/api/todos/1"), ("PATCH", "/api/todos/1"), ("DELETE", "/api/todos/1"), ("GET", "/api/auth/me")]

    @pytest.mark.parametrize("method,path", ROUTES)
    def test_no_token_is_401(self, anon, method, path):
        res = anon.request(method, path, json={"title": "x"} if method in ("POST", "PATCH") else None)
        assert res.status_code == 401
        assert res.headers["www-authenticate"] == "Bearer"

    @pytest.mark.parametrize("method,path", ROUTES)
    def test_a_garbage_token_is_401(self, anon, method, path):
        assert anon.request(method, path, headers=bearer("zzz")).status_code == 401

    def test_the_wrong_scheme_is_401(self, anon):
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        assert anon.get("/api/todos", headers={"Authorization": f"Basic {token}"}).status_code == 401

    def test_401_comes_before_404_and_before_422(self, anon):
        assert anon.patch("/api/todos/999", json={"done": True}).status_code == 401
        assert anon.post("/api/todos", json={"nonsense": 1}).status_code == 401

    def test_a_viewer_can_read(self, anon, viewer_token):
        assert anon.get("/api/todos", headers=bearer(viewer_token)).status_code == 200

    def test_a_viewer_can_add_and_change(self, anon, viewer_token):
        h = bearer(viewer_token)
        todo = anon.post("/api/todos", json={"title": "x"}, headers=h).json()
        assert anon.patch(f"/api/todos/{todo['id']}", json={"done": True}, headers=h).json()["done"] is True

    def test_a_viewer_cannot_delete_it_is_403(self, anon, viewer_token):
        h = bearer(viewer_token)
        todo = anon.post("/api/todos", json={"title": "x"}, headers=h).json()
        res = anon.delete(f"/api/todos/{todo['id']}", headers=h)
        assert res.status_code == 403
        assert res.json()["detail"] == "Only an admin can do that."

    def test_after_a_refused_delete_the_to_do_is_still_there(self, anon, viewer_token):
        h = bearer(viewer_token)
        todo = anon.post("/api/todos", json={"title": "x"}, headers=h).json()
        anon.delete(f"/api/todos/{todo['id']}", headers=h)
        assert anon.get(f"/api/todos/{todo['id']}", headers=h).status_code == 200

    def test_a_viewer_gets_403_even_for_an_id_that_does_not_exist(self, anon, viewer_token):
        assert anon.delete("/api/todos/999", headers=bearer(viewer_token)).status_code == 403  # no hint about what exists

    def test_an_admin_can_delete(self, client, make):
        todo = make()
        assert client.delete(f"/api/todos/{todo['id']}").status_code == 204

    def test_me_says_who_you_are(self, anon, viewer_token):
        res = anon.get("/api/auth/me", headers=bearer(viewer_token))
        assert res.json() == {"id": 1, "email": "viewer@example.com", "role": "viewer"}


class TestRefresh:
    def test_a_new_access_token_and_a_new_cookie(self, anon):
        first = sign_up(anon, "sam@example.com")
        old_cookie = anon.cookies.get("refresh_token")
        res = anon.post("/api/auth/refresh")
        assert res.status_code == 200
        assert res.json()["user"]["email"] == "sam@example.com"
        assert anon.cookies.get("refresh_token") != old_cookie  # rotated
        assert "HttpOnly" in cookie_header(res) and "Path=/api/auth" in cookie_header(res)
        assert first.json()["access_token"] is not None

    def test_the_new_access_token_works(self, anon):
        sign_up(anon, "sam@example.com")
        token = anon.post("/api/auth/refresh").json()["access_token"]
        assert anon.get("/api/todos", headers=bearer(token)).status_code == 200

    def test_no_cookie_is_401(self, anon):
        assert anon.post("/api/auth/refresh").status_code == 401

    def test_a_made_up_cookie_is_401_and_the_cookie_is_cleared(self, anon):
        anon.cookies.set("refresh_token", "made-up", path="/api/auth")
        res = anon.post("/api/auth/refresh")
        assert res.status_code == 401 and "Max-Age=0" in cookie_header(res)

    def test_an_expired_refresh_token_is_401(self, tmp_path):
        client = new_app_client(tmp_path, refresh_ttl_seconds=-5)
        sign_up(client, "sam@example.com")
        assert client.post("/api/auth/refresh").status_code == 401

    def test_each_refresh_token_works_only_once(self, anon):
        sign_up(anon, "sam@example.com")
        old = anon.cookies.get("refresh_token")
        assert anon.post("/api/auth/refresh").status_code == 200
        anon.cookies.clear()
        anon.cookies.set("refresh_token", old, path="/api/auth")
        assert anon.post("/api/auth/refresh").status_code == 401

    def test_reusing_an_old_token_cancels_the_whole_session(self, anon):
        """If an old token comes back, someone copied it. The newest token must stop working too."""
        sign_up(anon, "sam@example.com")
        old = anon.cookies.get("refresh_token")
        anon.post("/api/auth/refresh")
        newest = anon.cookies.get("refresh_token")
        anon.cookies.clear()
        anon.cookies.set("refresh_token", old, path="/api/auth")
        anon.post("/api/auth/refresh")  # the replay
        anon.cookies.clear()
        anon.cookies.set("refresh_token", newest, path="/api/auth")
        assert anon.post("/api/auth/refresh").status_code == 401

    def test_a_deleted_user_cannot_refresh(self, tmp_path):
        client = new_app_client(tmp_path)
        sign_up(client, "sam@example.com")
        with sqlite3.connect(tmp_path / "test.db") as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("DELETE FROM users")
        assert client.post("/api/auth/refresh").status_code == 401


class TestSignOut:
    def test_204_and_the_cookie_is_cleared(self, anon):
        sign_up(anon, "sam@example.com")
        res = anon.post("/api/auth/signout")
        assert res.status_code == 204 and res.content == b""
        header = cookie_header(res)
        assert "Max-Age=0" in header and "Path=/api/auth" in header  # same path, or the browser would keep the old one

    def test_the_refresh_token_stops_working_on_the_server(self, anon):
        sign_up(anon, "sam@example.com")
        old = anon.cookies.get("refresh_token")
        anon.post("/api/auth/signout")
        anon.cookies.set("refresh_token", old, path="/api/auth")  # a copy of the cookie somebody kept
        assert anon.post("/api/auth/refresh").status_code == 401

    def test_signing_out_when_not_signed_in_is_still_204(self, anon):
        assert anon.post("/api/auth/signout").status_code == 204

    def test_signing_out_one_session_leaves_the_other(self, anon):
        sign_up(anon, "sam@example.com")
        other = anon.cookies.get("refresh_token")
        anon.post("/api/auth/signin", json={"email": "sam@example.com", "password": PASSWORD})
        anon.post("/api/auth/signout")
        anon.cookies.clear()
        anon.cookies.set("refresh_token", other, path="/api/auth")
        assert anon.post("/api/auth/refresh").status_code == 200

    def test_an_access_token_still_works_until_it_expires(self, anon):
        """Known limit: access tokens are stateless. The short life is the protection, not sign-out."""
        token = sign_up(anon, "sam@example.com").json()["access_token"]
        anon.post("/api/auth/signout")
        assert anon.get("/api/todos", headers=bearer(token)).status_code == 200


class TestSettings:
    def test_admin_emails_are_read_trimmed_and_lowercased(self, monkeypatch):
        monkeypatch.setenv("ADMIN_EMAILS", " A@x.com , b@y.com ,, ")
        assert Settings.from_env().admin_emails == {"a@x.com", "b@y.com"}

    def test_the_token_life_comes_from_the_environment(self, monkeypatch):
        monkeypatch.setenv("ACCESS_TTL_SECONDS", "3")
        assert Settings.from_env().access_ttl_seconds == 3

    def test_secure_cookie_is_switched_on_by_the_environment(self, monkeypatch):
        monkeypatch.setenv("COOKIE_SECURE", "1")
        assert Settings.from_env().cookie_secure is True

    def test_a_secret_from_the_environment_is_used(self, monkeypatch):
        monkeypatch.setenv("JWT_SECRET", "from-the-environment")
        assert Settings.from_env().jwt_secret == "from-the-environment"

    def test_with_no_secret_a_random_one_is_made_each_start(self):
        assert Settings().jwt_secret != Settings().jwt_secret and len(Settings().jwt_secret) >= 48

    def test_by_default_nobody_is_an_admin(self):
        assert Settings().admin_emails == frozenset()
```

### `backend/tests/test_api.py`

```python
import pytest
from fastapi.testclient import TestClient

from app.main import ALLOWED_ORIGINS, create_app

from .conftest import ADMIN, bearer, make_settings, sign_up


class TestList:
    def test_empty_at_first(self, client):
        res = client.get("/api/todos")
        assert res.status_code == 200
        assert res.json() == []

    def test_returns_what_was_created_in_order(self, client, make):
        a, b = make("A"), make("B")
        assert [t["id"] for t in client.get("/api/todos").json()] == [a["id"], b["id"]]

    def test_each_item_has_exactly_the_contract_fields(self, client, make):
        make()
        assert set(client.get("/api/todos").json()[0]) == {"id", "title", "done", "created_at"}

    def test_filter_done_true_and_false(self, client, make):
        a, b = make("A"), make("B")
        client.patch(f"/api/todos/{a['id']}", json={"done": True})
        assert [t["title"] for t in client.get("/api/todos?done=true").json()] == ["A"]
        assert [t["title"] for t in client.get("/api/todos?done=false").json()] == ["B"]

    def test_search_is_case_insensitive_and_partial(self, client, make):
        make("Buy MILK"), make("Call mum")
        assert [t["title"] for t in client.get("/api/todos?q=milk").json()] == ["Buy MILK"]

    def test_search_with_an_ampersand_in_it(self, client, make):
        make("salt & pepper"), make("salt")
        res = client.get("/api/todos", params={"q": "salt & pepper"})  # httpx encodes the & as %26
        assert [t["title"] for t in res.json()] == ["salt & pepper"]

    def test_an_unencoded_ampersand_splits_the_query(self, client, make):
        # The mistake URLSearchParams prevents: "q=salt & pepper" is read as q="salt " plus a parameter named "pepper".
        make("salt & pepper"), make("salt and pepper")
        raw = client.get("/api/todos?q=salt%20&pepper").json()
        encoded = client.get("/api/todos", params={"q": "salt & pepper"}).json()
        assert len(raw) == 2 and len(encoded) == 1

    def test_percent_and_underscore_in_search_are_not_wildcards(self, client, make):
        make("50% off"), make("500 off"), make("a_b"), make("axb")
        assert [t["title"] for t in client.get("/api/todos", params={"q": "50%"}).json()] == ["50% off"]
        assert [t["title"] for t in client.get("/api/todos", params={"q": "a_b"}).json()] == ["a_b"]

    def test_search_and_filter_together(self, client, make):
        a = make("milk one")
        make("milk two")
        client.patch(f"/api/todos/{a['id']}", json={"done": True})
        assert [t["title"] for t in client.get("/api/todos?q=milk&done=true").json()] == ["milk one"]

    @pytest.mark.parametrize("query", ["done=maybe", "done=2", "q=" + "x" * 121])
    def test_bad_query_is_422(self, client, query):
        assert client.get(f"/api/todos?{query}").status_code == 422


class TestCreate:
    def test_201_and_the_new_todo(self, client):
        res = client.post("/api/todos", json={"title": "Buy milk"})
        assert res.status_code == 201
        body = res.json()
        assert body["title"] == "Buy milk" and body["done"] is False and body["id"] >= 1
        assert body["created_at"].endswith("Z")

    def test_location_header_points_at_the_new_todo(self, client):
        res = client.post("/api/todos", json={"title": "Buy milk"})
        location = res.headers["location"]
        assert location == f"/api/todos/{res.json()['id']}"
        assert client.get(location).json() == res.json()

    def test_title_is_trimmed(self, client):
        assert client.post("/api/todos", json={"title": "  hi  "}).json()["title"] == "hi"

    def test_a_120_character_title_is_fine(self, client):
        assert client.post("/api/todos", json={"title": "x" * 120}).status_code == 201

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"title": ""},
            {"title": "   "},
            {"title": None},
            {"title": 5},
            {"title": True},
            {"title": ["a"]},
            {"title": "x" * 121},
            {"title": "ok", "done": True},
            {"title": "ok", "id": 9},
            {"name": "ok"},
            [],
            "just a string",
        ],
    )
    def test_bad_body_is_422(self, client, body):
        assert client.post("/api/todos", json=body).status_code == 422

    def test_not_json_is_422(self, client):
        res = client.post("/api/todos", content="title=hi", headers={"Content-Type": "application/json"})
        assert res.status_code == 422

    def test_a_refused_todo_is_not_stored(self, client):
        client.post("/api/todos", json={"title": ""})
        assert client.get("/api/todos").json() == []

    def test_ids_are_not_reused_after_a_delete(self, client, make):
        a = make("A")
        client.delete(f"/api/todos/{a['id']}")
        assert make("B")["id"] != a["id"]


class TestGetOne:
    def test_200(self, client, make):
        todo = make()
        assert client.get(f"/api/todos/{todo['id']}").json() == todo

    def test_404(self, client):
        res = client.get("/api/todos/999")
        assert res.status_code == 404
        assert res.json() == {"detail": "No such to-do."}

    def test_a_non_number_id_is_422_not_404(self, client):
        assert client.get("/api/todos/abc").status_code == 422


class TestPatch:
    def test_toggle_done(self, client, make):
        todo = make()
        res = client.patch(f"/api/todos/{todo['id']}", json={"done": True})
        assert res.status_code == 200
        assert res.json()["done"] is True
        assert res.json()["title"] == "Buy milk"  # the title was not touched

    def test_rename(self, client, make):
        todo = make()
        res = client.patch(f"/api/todos/{todo['id']}", json={"title": "Buy bread"})
        assert res.json()["title"] == "Buy bread" and res.json()["done"] is False

    def test_both_at_once(self, client, make):
        todo = make()
        body = client.patch(f"/api/todos/{todo['id']}", json={"title": "New", "done": True}).json()
        assert (body["title"], body["done"]) == ("New", True)

    def test_can_be_undone(self, client, make):
        todo = make()
        client.patch(f"/api/todos/{todo['id']}", json={"done": True})
        assert client.patch(f"/api/todos/{todo['id']}", json={"done": False}).json()["done"] is False

    def test_the_change_is_stored(self, client, make):
        todo = make()
        client.patch(f"/api/todos/{todo['id']}", json={"done": True})
        assert client.get(f"/api/todos/{todo['id']}").json()["done"] is True

    def test_404(self, client):
        assert client.patch("/api/todos/999", json={"done": True}).status_code == 404

    def test_404_is_checked_before_the_body_is_applied(self, client):
        assert client.patch("/api/todos/999", json={"title": "x"}).json() == {"detail": "No such to-do."}

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"title": None},
            {"done": None},
            {"title": ""},
            {"title": "   "},
            {"done": "yes"},
            {"done": 1},
            {"done": "true"},
            {"title": 7},
            {"title": "x" * 121},
            {"id": 5},
            {"created_at": "2000-01-01T00:00:00Z"},
            {"done": True, "extra": 1},
        ],
    )
    def test_bad_body_is_422(self, client, make, body):
        todo = make()
        assert client.patch(f"/api/todos/{todo['id']}", json=body).status_code == 422

    def test_a_422_changes_nothing(self, client, make):
        todo = make()
        client.patch(f"/api/todos/{todo['id']}", json={"title": "ok", "done": "yes"})
        assert client.get(f"/api/todos/{todo['id']}").json() == todo

    def test_a_non_number_id_is_422(self, client):
        assert client.patch("/api/todos/abc", json={"done": True}).status_code == 422


class TestDelete:
    def test_204_with_no_body(self, client, make):
        todo = make()
        res = client.delete(f"/api/todos/{todo['id']}")
        assert res.status_code == 204
        assert res.content == b""

    def test_it_is_gone(self, client, make):
        todo = make()
        client.delete(f"/api/todos/{todo['id']}")
        assert client.get(f"/api/todos/{todo['id']}").status_code == 404
        assert client.get("/api/todos").json() == []

    def test_deleting_twice_is_404_the_second_time(self, client, make):
        todo = make()
        assert client.delete(f"/api/todos/{todo['id']}").status_code == 204
        assert client.delete(f"/api/todos/{todo['id']}").status_code == 404

    def test_404(self, client):
        assert client.delete("/api/todos/999").status_code == 404

    def test_only_the_one_is_deleted(self, client, make):
        a, b = make("A"), make("B")
        client.delete(f"/api/todos/{a['id']}")
        assert [t["id"] for t in client.get("/api/todos").json()] == [b["id"]]


class TestNoTrailingSlash:
    @pytest.mark.parametrize("path", ["/api/todos/", "/api/todos/1/"])
    def test_a_trailing_slash_is_a_plain_404_not_a_307(self, client, make, path):
        make()
        res = client.get(path, follow_redirects=False)
        assert res.status_code == 404  # a 307 here would mean a hidden redirect

    def test_post_with_a_trailing_slash_is_not_redirected_either(self, client):
        assert client.post("/api/todos/", json={"title": "x"}, follow_redirects=False).status_code == 404

    def test_every_route_in_the_contract_has_no_trailing_slash(self, client):
        paths = client.get("/openapi.json").json()["paths"]
        assert all(not p.endswith("/") for p in paths)


class TestOpenApi:
    def test_docs_page_exists(self, client):
        assert client.get("/docs").status_code == 200

    def test_the_contract_is_in_openapi(self, client):
        paths = client.get("/openapi.json").json()["paths"]
        todo_paths = {p for p in paths if p.startswith("/api/todos")}
        assert todo_paths == {"/api/todos", "/api/todos/{todo_id}"}
        assert set(paths["/api/todos"]) == {"get", "post"}
        assert set(paths["/api/todos/{todo_id}"]) == {"get", "patch", "delete"}

    def test_the_documented_status_codes(self, client):
        paths = client.get("/openapi.json").json()["paths"]
        assert "201" in paths["/api/todos"]["post"]["responses"]
        assert "204" in paths["/api/todos/{todo_id}"]["delete"]["responses"]


class TestPersistence:
    def test_data_survives_a_restart(self, tmp_path):
        path = str(tmp_path / "keep.db")
        first = TestClient(create_app(path, make_settings()))
        first.headers.update(bearer(sign_up(first, ADMIN).json()["access_token"]))
        first.post("/api/todos", json={"title": "Keep me"})
        second = TestClient(create_app(path, make_settings()))  # a new server on the same file (same secret)
        second.headers.update(first.headers)  # the old access token still works: same secret, same database
        assert [t["title"] for t in second.get("/api/todos").json()] == ["Keep me"]

    def test_two_servers_with_different_files_do_not_share(self, tmp_path):
        a = TestClient(create_app(str(tmp_path / "a.db"), make_settings()))
        b = TestClient(create_app(str(tmp_path / "b.db"), make_settings()))
        for c in (a, b):
            c.headers.update(bearer(sign_up(c, ADMIN).json()["access_token"]))
        a.post("/api/todos", json={"title": "only in a"})
        assert b.get("/api/todos").json() == []

    def test_reads_the_path_from_the_environment(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TODO_DB", str(tmp_path / "env.db"))
        TestClient(create_app(settings=make_settings()))
        assert (tmp_path / "env.db").exists()


class TestSqlSafety:
    def test_a_quote_in_a_title_is_just_text(self, client):
        title = "Robert'); DROP TABLE todos;--"
        todo = client.post("/api/todos", json={"title": title}).json()
        assert client.get(f"/api/todos/{todo['id']}").json()["title"] == title
        assert len(client.get("/api/todos").json()) == 1

    def test_a_quote_in_a_search_is_just_text(self, client, make):
        make("it's fine")
        assert len(client.get("/api/todos", params={"q": "it's"}).json()) == 1
        assert client.get("/api/todos", params={"q": "' OR '1'='1"}).json() == []

    def test_unicode_titles_work(self, client):
        assert client.post("/api/todos", json={"title": "పాలు కొనండి ☕"}).json()["title"] == "పాలు కొనండి ☕"
```

### `backend/tests/test_cors.py`

```python
import pytest

from app.main import ALLOWED_ORIGINS

ORIGIN = "http://localhost:5173"


def preflight(client, origin=ORIGIN, method="PATCH", headers="content-type", path="/api/todos/1"):
    return client.options(
        path,
        headers={"Origin": origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers},
    )


def test_there_are_two_exact_origins_and_no_wildcard():
    assert ALLOWED_ORIGINS == ["http://localhost:5173", "http://127.0.0.1:5173"]
    assert "*" not in ALLOWED_ORIGINS


@pytest.mark.parametrize("origin", ALLOWED_ORIGINS)
def test_the_patch_preflight_succeeds_for_each_origin(client, origin):
    res = preflight(client, origin)
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == origin
    assert "PATCH" in res.headers["access-control-allow-methods"]
    assert "content-type" in res.headers["access-control-allow-headers"].lower()


@pytest.mark.parametrize("method", ["GET", "POST", "PATCH", "DELETE"])
def test_every_method_in_the_contract_is_allowed(client, method):
    assert preflight(client, method=method).status_code == 200


def test_put_is_not_allowed(client):
    assert preflight(client, method="PUT").status_code == 400


def test_another_origin_is_refused(client):
    res = preflight(client, "http://evil.example")
    assert res.status_code == 400
    assert "access-control-allow-origin" not in res.headers


def test_a_different_port_is_a_different_origin(client):
    assert preflight(client, "http://localhost:5174").status_code == 400


def test_a_header_that_is_not_listed_is_refused(client):
    assert preflight(client, headers="x-secret").status_code == 400


def test_the_preflight_can_be_cached_for_ten_minutes(client):
    assert preflight(client).headers["access-control-max-age"] == "600"


def test_a_normal_response_carries_the_allow_origin_header(client):
    res = client.get("/api/todos", headers={"Origin": ORIGIN})
    assert res.headers["access-control-allow-origin"] == ORIGIN


def test_a_normal_response_to_another_origin_does_not(client):
    assert "access-control-allow-origin" not in client.get("/api/todos", headers={"Origin": "http://evil.example"}).headers


def test_location_is_exposed_so_the_page_can_read_it(client):
    res = client.post("/api/todos", json={"title": "x"}, headers={"Origin": ORIGIN})
    assert "location" in res.headers["access-control-expose-headers"].lower()


def test_the_preflight_never_touches_the_data(client, make):
    todo = make()
    preflight(client, path=f"/api/todos/{todo['id']}")
    assert client.get(f"/api/todos/{todo['id']}").json() == todo


# ---- Day 42: credentials and the Authorization header -----------------------------------------------------------------

def test_the_authorization_header_is_allowed_in_a_preflight(client):
    res = preflight(client, headers="authorization,content-type", method="DELETE")
    assert res.status_code == 200
    assert "authorization" in res.headers["access-control-allow-headers"].lower()


def test_credentials_are_allowed_for_the_page_so_the_refresh_cookie_can_travel(client):
    res = preflight(client, path="/api/auth/refresh", method="POST")
    assert res.headers["access-control-allow-credentials"] == "true"


def test_the_allow_origin_is_the_exact_page_never_a_star_when_credentials_are_on(client):
    res = client.post("/api/auth/refresh", headers={"Origin": ORIGIN})
    assert res.headers["access-control-allow-origin"] == ORIGIN
    assert res.headers["access-control-allow-credentials"] == "true"


def test_a_refused_refresh_still_carries_the_cors_headers_so_the_page_can_read_the_401(anon):
    res = anon.post("/api/auth/refresh", headers={"Origin": ORIGIN})
    assert res.status_code == 401 and res.headers["access-control-allow-origin"] == ORIGIN


def test_a_stranger_is_refused_and_gets_no_allow_origin(client):
    """Starlette still adds allow-credentials to the refusal, which is harmless: without allow-origin the browser blocks it."""
    res = preflight(client, origin="http://evil.example", path="/api/auth/refresh", method="POST")
    assert res.status_code == 400 and "access-control-allow-origin" not in res.headers
```

### `frontend/src/test/setup.ts`

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetSession } from "../session";
import { resetServer, server } from "./server";

// React reports mistakes with console.error. Any console.error fails the test.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  const calls = errorSpy.mock.calls.map((c: unknown[]) => c.join(" "));
  errorSpy.mockRestore();
  expect(calls, "console.error was called during the test").toEqual([]);
});

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetServer();
  resetSession();
  localStorage.clear();
  sessionStorage.clear();
});
afterAll(() => server.close());
```

### `frontend/src/test/server.ts` (the fake sign-in server)

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const BASE = "http://localhost:8000/api";

export interface FakeTodo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

/** The fake sign-in server. Tests change these fields to set the scene. */
export const auth = {
  validTokens: new Set<string>(), // access tokens the fake to-do routes accept
  refreshOk: false, // does the refresh cookie still work?
  refreshCalls: 0,
  refreshDelayMs: 0,
  signoutCalls: 0,
  role: "viewer" as "viewer" | "admin",
  email: "sam@example.com",
  counter: 0,
  lastAuthHeader: null as string | null,
};
const issue = () => {
  const token = `token-${++auth.counter}`;
  auth.validTokens = new Set([token]); // a new token replaces the old one, as if the old one had expired
  return { access_token: token, token_type: "bearer", expires_in: 300, user: { id: 1, email: auth.email, role: auth.role } };
};
/** Pretend the access token has run out. The next to-do request gets a 401. */
export const expireToken = () => (auth.validTokens = new Set());
const needLogin = (request: Request) => {
  auth.lastAuthHeader = request.headers.get("authorization");
  const token = auth.lastAuthHeader?.replace(/^Bearer /, "");
  return token && auth.validTokens.has(token) ? null : HttpResponse.json({ detail: "Your session expired." }, { status: 401 });
};

export let todos: FakeTodo[] = [];
export const requests: string[] = []; // e.g. "GET /api/todos?q=milk" or "PATCH /api/todos/2"
export let lastBody: unknown = undefined;
let nextId = 1;

export const seed = (...titles: string[]) => {
  titles.forEach((title) => todos.push({ id: nextId++, title, done: false, created_at: "2026-11-06T10:00:00Z" }));
};
export const resetServer = () => {
  auth.validTokens = new Set();
  auth.refreshOk = false;
  auth.refreshCalls = 0;
  auth.refreshDelayMs = 0;
  auth.signoutCalls = 0;
  auth.role = "viewer";
  auth.email = "sam@example.com";
  auth.counter = 0;
  auth.lastAuthHeader = null;
  todos = [];
  nextId = 1;
  requests.length = 0;
  lastBody = undefined;
};

/** Holds an answer back until open() is called. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export const handlers = [
  http.get(`${BASE}/todos`, ({ request }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    const url = new URL(request.url);
    requests.push(`GET ${url.pathname}${url.search}`);
    const q = url.searchParams.get("q")?.toLowerCase();
    const done = url.searchParams.get("done");
    const items = todos.filter((t) => (!q || t.title.toLowerCase().includes(q)) && (done === null || t.done === (done === "true")));
    return HttpResponse.json(items);
  }),
  http.post(`${BASE}/todos`, async ({ request }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    lastBody = await request.json();
    requests.push("POST /api/todos");
    const title = String((lastBody as { title?: string }).title ?? "").trim();
    if (!title) {
      return HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty.", type: "value_error" }] }, { status: 422 });
    }
    const todo: FakeTodo = { id: nextId++, title, done: false, created_at: "2026-11-06T10:00:00Z" };
    todos.push(todo);
    return HttpResponse.json(todo, { status: 201, headers: { Location: `/api/todos/${todo.id}` } });
  }),
  http.patch(`${BASE}/todos/:id`, async ({ request, params }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    lastBody = await request.json();
    requests.push(`PATCH /api/todos/${params.id}`);
    const todo = todos.find((t) => t.id === Number(params.id));
    if (!todo) return HttpResponse.json({ detail: "No such to-do." }, { status: 404 });
    Object.assign(todo, lastBody);
    return HttpResponse.json(todo);
  }),
  http.delete(`${BASE}/todos/:id`, ({ request, params }) => {
    const denied = needLogin(request);
    if (denied) return denied;
    if (auth.role !== "admin") return HttpResponse.json({ detail: "Only an admin can do that." }, { status: 403 });
    requests.push(`DELETE /api/todos/${params.id}`);
    const index = todos.findIndex((t) => t.id === Number(params.id));
    if (index === -1) return HttpResponse.json({ detail: "No such to-do." }, { status: 404 });
    todos.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${BASE}/auth/signin`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    requests.push("POST /api/auth/signin");
    if (body.email === "sam@example.com" && body.password === "correct horse") {
      auth.refreshOk = true;
      return HttpResponse.json(issue());
    }
    return HttpResponse.json({ detail: "Wrong email or password." }, { status: 401 }); // the same for a wrong email and a wrong password
  }),
  http.post(`${BASE}/auth/signup`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    requests.push("POST /api/auth/signup");
    if (body.email === "taken@example.com") return HttpResponse.json({ detail: "That email is already registered. Try signing in." }, { status: 409 });
    if (body.password.length < 8) {
      return HttpResponse.json({ detail: [{ loc: ["body", "password"], msg: "String should have at least 8 characters", type: "string_too_short" }] }, { status: 422 });
    }
    auth.email = body.email;
    auth.refreshOk = true;
    return HttpResponse.json(issue(), { status: 201 });
  }),
  http.post(`${BASE}/auth/refresh`, async () => {
    auth.refreshCalls++;
    requests.push("POST /api/auth/refresh");
    if (auth.refreshDelayMs) await new Promise((r) => setTimeout(r, auth.refreshDelayMs));
    if (!auth.refreshOk) return HttpResponse.json({ detail: "Not signed in." }, { status: 401 });
    return HttpResponse.json(issue());
  }),
  http.post(`${BASE}/auth/signout`, () => {
    auth.signoutCalls++;
    requests.push("POST /api/auth/signout");
    auth.refreshOk = false;
    return new HttpResponse(null, { status: 204 });
  }),
];

export const server = setupServer(...handlers);
export { http, HttpResponse };
```

### `frontend/src/test/render.tsx`

```tsx
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
```

### `frontend/src/session.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { request } from "./api/client";
import { NetworkError, ServerError } from "./api/errors";
import { deleteTodo, listTodos } from "./api/todos";
import { bootstrap, getAccessToken, getSession, renewToken, signIn, signOut } from "./session";
import { auth, BASE, expireToken, gate, http, HttpResponse, requests, seed, server } from "./test/server";

const GOOD = ["sam@example.com", "correct horse"] as const;

describe("signing in", () => {
  it("keeps the token in memory and knows who you are", async () => {
    await signIn(...GOOD);
    expect(getAccessToken()).toBe("token-1");
    expect(getSession()).toMatchObject({ status: "signedIn", user: { email: "sam@example.com", role: "viewer" } });
  });

  it("leaves NOTHING in localStorage, sessionStorage or document.cookie", async () => {
    await signIn(...GOOD);
    await listTodos();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("a wrong password is a 401 with the server's sentence, and does NOT start a refresh", async () => {
    const error = await signIn("sam@example.com", "wrong").catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Wrong email or password.");
    expect(auth.refreshCalls).toBe(0);
    expect(getSession().status).toBe("loading");
  });

  it("a wrong email gives exactly the same error as a wrong password", async () => {
    const wrongPassword = await signIn("sam@example.com", "wrong").catch((e) => e);
    const wrongEmail = await signIn("nobody@example.com", "correct horse").catch((e) => e);
    expect([wrongEmail.status, wrongEmail.message]).toEqual([wrongPassword.status, wrongPassword.message]);
  });
});

describe("the token is added to every call", () => {
  it("as a Bearer header", async () => {
    await signIn(...GOOD);
    await listTodos();
    expect(auth.lastAuthHeader).toBe("Bearer token-1");
  });

  it("the sign-in calls themselves carry no token", async () => {
    await signIn(...GOOD);
    let header: string | null = "unset";
    server.use(http.post(`${BASE}/auth/signin`, ({ request: r }) => ((header = r.headers.get("authorization")), HttpResponse.json({ detail: "x" }, { status: 401 }))));
    await signIn(...GOOD).catch(() => {});
    expect(header).toBeNull();
  });

  it("every call lets the cookie travel (credentials: include)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await signIn(...GOOD);
    await listTodos();
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(spy.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
    spy.mockRestore();
  });
});

describe("an expired token is renewed once, and the call is tried once more", () => {
  it("one call: refresh, retry with the new token, success", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    expireToken();
    const spy = vi.spyOn(globalThis, "fetch");
    const items = await listTodos();
    const listCalls = spy.mock.calls.filter(([url]) => String(url).includes("/todos")).length;
    spy.mockRestore();
    expect(items.map((t) => t.title)).toEqual(["Buy milk"]);
    expect(auth.refreshCalls).toBe(1);
    expect(auth.lastAuthHeader).toBe("Bearer token-2");
    expect(listCalls).toBe(2); // the failed try and the retry
  });

  it("THREE calls at the same moment make exactly ONE refresh call", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    auth.refreshDelayMs = 30; // slow enough that all three have hit the 401 before the first refresh is done
    expireToken();
    const results = await Promise.all([listTodos(), listTodos(), listTodos()]);
    expect(results.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(auth.refreshCalls).toBe(1);
  });

  it("a call whose 401 arrives AFTER the renewal does not start a second refresh", async () => {
    await signIn(...GOOD);
    const slow = gate();
    let seen = 0;
    server.use(
      http.get(`${BASE}/todos`, async ({ request: r }) => {
        if (r.headers.get("authorization") === "Bearer token-1") {
          if (seen++ === 1) await slow.promise; // the second call is held back
          return HttpResponse.json({ detail: "Your session expired." }, { status: 401 });
        }
        return HttpResponse.json([]);
      }),
    );
    const first = listTodos();
    const second = listTodos();
    await first; // the first call refreshed and retried
    slow.open(); // now the second call's 401 comes in, late
    await second;
    expect(auth.refreshCalls).toBe(1);
  });

  it("a second 401 after the retry is an error. There is no loop", async () => {
    await signIn(...GOOD);
    let tries = 0;
    server.use(http.get(`${BASE}/todos`, () => (tries++, HttpResponse.json({ detail: "No." }, { status: 401 }))));
    const error = await listTodos().catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(401);
    expect(tries).toBe(2);
    expect(auth.refreshCalls).toBe(1);
  });

  it("if the refresh is refused, the person is signed out with a notice", async () => {
    await signIn(...GOOD);
    auth.refreshOk = false;
    expireToken();
    const error = await listTodos().catch((e) => e);
    expect(error.status).toBe(401);
    expect(getAccessToken()).toBeNull();
    expect(getSession()).toEqual({ status: "signedOut", user: null, notice: "Your session ended. Please sign in again." });
  });

  it("if the server cannot be reached during the refresh, the person stays signed in", async () => {
    await signIn(...GOOD);
    expireToken();
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.error()));
    const error = await listTodos().catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(getSession().status).toBe("signedIn");
  });

  it("a refresh that fails with a 500 does not sign anyone out", async () => {
    await signIn(...GOOD);
    expireToken();
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ detail: "boom" }, { status: 500 })));
    const error = await listTodos().catch((e) => e);
    expect(error.status).toBe(500);
    expect(getSession().status).toBe("signedIn");
  });

  it("calls to /auth never trigger a refresh of their own", async () => {
    await signOut();
    expect(auth.refreshCalls).toBe(0);
  });

  it("renewToken called twice at once shares one refresh call", async () => {
    auth.refreshOk = true;
    auth.refreshDelayMs = 20;
    const [a, b] = await Promise.all([renewToken(null), renewToken(null)]);
    expect(a).toBe(b);
    expect(auth.refreshCalls).toBe(1);
  });
});

describe("the page loads: try the cookie", () => {
  it("a working cookie signs you in with no password", async () => {
    auth.refreshOk = true;
    await bootstrap();
    expect(getSession().status).toBe("signedIn");
    expect(requests).toEqual(["POST /api/auth/refresh"]);
  });

  it("no cookie means signed out, with no notice (nothing ended)", async () => {
    await bootstrap();
    expect(getSession()).toEqual({ status: "signedOut", user: null, notice: null });
  });

  it("no server means signed out so the sign-in page shows", async () => {
    server.use(http.post(`${BASE}/auth/refresh`, () => HttpResponse.error()));
    await bootstrap();
    expect(getSession().status).toBe("signedOut");
  });
});

describe("signing out", () => {
  it("tells the server, forgets the token and the person", async () => {
    await signIn(...GOOD);
    await signOut();
    expect(auth.signoutCalls).toBe(1);
    expect(getAccessToken()).toBeNull();
    expect(getSession().status).toBe("signedOut");
  });

  it("still signs out on this screen when the server cannot be reached", async () => {
    await signIn(...GOOD);
    server.use(http.post(`${BASE}/auth/signout`, () => HttpResponse.error()));
    await signOut();
    expect(getAccessToken()).toBeNull();
    expect(getSession().status).toBe("signedOut");
  });
});

describe("a viewer who sends DELETE", () => {
  it("gets a 403 with the server's sentence", async () => {
    await signIn(...GOOD);
    seed("Buy milk");
    const error = await deleteTodo(1).catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.status).toBe(403);
    expect(error.message).toBe("Only an admin can do that.");
  });

  it("and a 403 does NOT trigger a refresh (that is for 401 only)", async () => {
    await signIn(...GOOD);
    await deleteTodo(1).catch(() => {});
    expect(auth.refreshCalls).toBe(0);
  });

  it("an admin can", async () => {
    auth.role = "admin";
    await signIn(...GOOD);
    seed("Buy milk");
    await expect(deleteTodo(1)).resolves.toBeUndefined();
  });
});
```

### `frontend/src/auth/auth-ui.test.tsx`

```tsx
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
```

### `frontend/src/pages/TodoPage.test.tsx`

```tsx
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
```

### `frontend/src/api/client.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildUrl, DEFAULT_TIMEOUT_MS, request } from "./client";
import { NetworkError, ServerError } from "./errors";
import { BASE, http, HttpResponse, requests, server } from "../test/server";

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
};

describe("buildUrl", () => {
  it("joins base and path", () => {
    expect(buildUrl("/api", "/todos")).toBe("/api/todos");
  });
  it("adds a query string", () => {
    expect(buildUrl("/api", "/todos", { done: true, q: "milk" })).toBe("/api/todos?done=true&q=milk");
  });
  it("leaves out undefined values and an empty query", () => {
    expect(buildUrl("/api", "/todos", { q: undefined })).toBe("/api/todos");
    expect(buildUrl("/api", "/todos")).toBe("/api/todos");
  });
  it("encodes & = spaces and # so they cannot split or end the query", () => {
    const url = buildUrl("/api", "/todos", { q: "a & b=c #1" });
    expect(url).toBe("/api/todos?q=a+%26+b%3Dc+%231");
    expect(new URL(url, "http://x").searchParams.get("q")).toBe("a & b=c #1");
  });
  it("keeps a non-English search intact", () => {
    expect(new URL(buildUrl("/api", "/todos", { q: "పాలు" }), "http://x").searchParams.get("q")).toBe("పాలు");
  });
});

describe("request: success", () => {
  it("returns the parsed JSON", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ a: 1 })));
    expect(await request("/thing")).toEqual({ a: 1 });
  });
  it("sends no content type on a GET", async () => {
    let seen: string | null = "unset";
    server.use(http.get(`${BASE}/thing`, ({ request }) => ((seen = request.headers.get("content-type")), HttpResponse.json({}))));
    await request("/thing");
    expect(seen).toBeNull();
  });
  it("sends JSON and a content type on a POST or PATCH", async () => {
    const seen: Array<{ method: string; type: string | null; body: unknown }> = [];
    server.use(
      http.post(`${BASE}/thing`, async ({ request }) => (seen.push({ method: "POST", type: request.headers.get("content-type"), body: await request.json() }), HttpResponse.json({}))),
      http.patch(`${BASE}/thing`, async ({ request }) => (seen.push({ method: "PATCH", type: request.headers.get("content-type"), body: await request.json() }), HttpResponse.json({}))),
    );
    await request("/thing", { method: "POST", body: { x: 1 } });
    await request("/thing", { method: "PATCH", body: { y: 2 } });
    expect(seen).toEqual([
      { method: "POST", type: "application/json", body: { x: 1 } },
      { method: "PATCH", type: "application/json", body: { y: 2 } },
    ]);
  });
  it("a 204 returns undefined and does not try to read a body", async () => {
    server.use(http.delete(`${BASE}/thing`, () => new HttpResponse(null, { status: 204 })));
    expect(await request("/thing", { method: "DELETE" })).toBeUndefined();
  });
  it("a 201 is a success", async () => {
    server.use(http.post(`${BASE}/thing`, () => HttpResponse.json({ id: 1 }, { status: 201 })));
    expect(await request("/thing", { method: "POST", body: {} })).toEqual({ id: 1 });
  });
  it("puts the query in the request", async () => {
    server.use(http.get(`${BASE}/todos`, ({ request: r }) => (requests.push(`GET ${new URL(r.url).pathname}${new URL(r.url).search}`), HttpResponse.json([]))));
    await request("/todos", { query: { q: "a & b" } });
    expect(requests[0]).toBe("GET /api/todos?q=a+%26+b");
  });
});

describe("request: the server said no -> ServerError", () => {
  it.each([400, 404, 409, 422, 500, 503])("status %s", async (status) => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ detail: "nope" }, { status })));
    const error = await caught(request("/thing"));
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(status);
  });
  it("uses the server's reason when it is a string", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.json({ detail: "No such to-do." }, { status: 404 })));
    expect(((await caught(request("/thing"))) as ServerError).message).toBe("No such to-do.");
  });
  it("turns FastAPI's 422 list into messages per field", async () => {
    server.use(
      http.post(`${BASE}/thing`, () =>
        HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "Value error, Title cannot be empty." }, { loc: ["body", "done"], msg: "Input should be a valid boolean" }] }, { status: 422 }),
      ),
    );
    const error = (await caught(request("/thing", { method: "POST", body: {} }))) as ServerError;
    expect(error.fieldErrors).toEqual({ title: "Title cannot be empty.", done: "Input should be a valid boolean" });
  });
  it("keeps the first message when a field has two", async () => {
    server.use(http.post(`${BASE}/thing`, () => HttpResponse.json({ detail: [{ loc: ["body", "title"], msg: "first" }, { loc: ["body", "title"], msg: "second" }] }, { status: 422 })));
    expect(((await caught(request("/thing", { method: "POST", body: {} }))) as ServerError).fieldErrors).toEqual({ title: "first" });
  });
  it("a non-JSON error page (a proxy's 502) still becomes a ServerError", async () => {
    server.use(http.get(`${BASE}/thing`, () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })));
    const error = (await caught(request("/thing"))) as ServerError;
    expect(error).toBeInstanceOf(ServerError);
    expect(error.message).toBe("Request failed (502).");
  });
  it("a 200 whose body is not JSON is a ServerError, not a crash", async () => {
    server.use(http.get(`${BASE}/thing`, () => new HttpResponse("not json", { status: 200 })));
    expect(await caught(request("/thing"))).toBeInstanceOf(ServerError);
  });
});

describe("request: no server -> NetworkError", () => {
  it("a network failure is unreachable", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.error()));
    const error = await caught(request("/thing"));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("unreachable");
  });
  it("it is NOT a ServerError (the two are different kinds)", async () => {
    server.use(http.get(`${BASE}/thing`, () => HttpResponse.error()));
    expect(await caught(request("/thing"))).not.toBeInstanceOf(ServerError);
  });
  it("a request that gets no answer in time is a timeout", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const error = await caught(request("/thing", { timeoutMs: 60 }));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("timeout");
  });
  it("the default timeout is 8 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });
});

describe("request: cancelling", () => {
  it("the caller's cancel is rethrown as it is (not a NetworkError)", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const controller = new AbortController();
    const pending = caught(request("/thing", { signal: controller.signal }));
    controller.abort();
    const error = (await pending) as Error;
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(NetworkError);
  });
  it("the timeout still works when the caller passes its own signal", async () => {
    server.use(http.get(`${BASE}/thing`, () => new Promise<never>(() => {})));
    const controller = new AbortController(); // never cancelled
    const error = await caught(request("/thing", { signal: controller.signal, timeoutMs: 60 }));
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).reason).toBe("timeout");
  });
  it("a signal that was already cancelled stops it at once", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(((await caught(request("/todos", { signal: controller.signal }))) as Error).name).toBe("AbortError");
    expect(requests).toEqual([]);
  });
});
```

### `frontend/src/api/adapter.test.ts`

```ts
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
```

### `frontend/src/api/env.test.ts`

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_BASE, readApiBase } from "./env";

describe("readApiBase", () => {
  it("returns the value", () => {
    expect(readApiBase({ VITE_API_BASE_URL: "/api" })).toBe("/api");
    expect(readApiBase({ VITE_API_BASE_URL: "http://localhost:8000/api" })).toBe("http://localhost:8000/api");
  });
  it("removes trailing slashes", () => {
    expect(readApiBase({ VITE_API_BASE_URL: "/api/" })).toBe("/api");
    expect(readApiBase({ VITE_API_BASE_URL: "http://x/api///" })).toBe("http://x/api");
  });
  it("fails loudly when it is missing, empty or only spaces", () => {
    for (const value of [undefined, "", "   "]) expect(() => readApiBase({ VITE_API_BASE_URL: value })).toThrow(/VITE_API_BASE_URL is not set/);
  });
  it("the test environment has an address", () => {
    expect(API_BASE).toBe("http://localhost:8000/api");
  });
});

describe("the env files", () => {
  const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "..", name), "utf8");
  it("proxy mode uses a relative address (same origin, no CORS)", () => {
    expect(read(".env.development")).toMatch(/^VITE_API_BASE_URL=\/api$/m);
  });
  it("cors mode uses the full backend address (different origin)", () => {
    expect(read(".env.cors")).toMatch(/^VITE_API_BASE_URL=http:\/\/localhost:8000\/api$/m);
  });
  it("only VITE_ variables are used (anything else never reaches the browser)", () => {
    for (const file of [".env.development", ".env.cors", ".env.example", ".env.test"]) {
      const names = [...read(file).matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^VITE_/);
    }
  });
});

describe("ImportMetaEnv is typed (TypeScript catches a typo)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const tsc = () => {
    try {
      execFileSync("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "pipe" });
      return "";
    } catch (error) {
      return String((error as { stdout?: Buffer }).stdout ?? "");
    }
  };

  it("a misspelled variable name is a compile error, and the right name is not", () => {
    const file = join(root, "src", "typo_probe.ts");
    try {
      writeFileSync(file, "export const ok = import.meta.env.VITE_API_BASE_URL;\n");
      expect(tsc(), "the correct name must compile").toBe("");
      writeFileSync(file, "export const typo = import.meta.env.VITE_API_BASE_URI;\n");
      const output = tsc();
      expect(output).toMatch(/typo_probe\.ts/);
      expect(output).toMatch(/VITE_API_BASE_URI/);
    } finally {
      if (existsSync(file)) unlinkSync(file);
    }
  }, 60000);
});
```

### `frontend/src/messages.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { NetworkError, ServerError } from "./api/errors";
import { describeError } from "./messages";

describe("describeError", () => {
  it("no server: tells you to check it is running", () => {
    expect(describeError(new NetworkError("unreachable"))).toBe("Cannot reach the server. Check that it is running, then try again.");
  });
  it("too slow: a different message from no server", () => {
    expect(describeError(new NetworkError("timeout"))).toBe("The server took too long to answer. Try again in a moment.");
  });
  it("a 500: says the server had a problem and shows the status", () => {
    expect(describeError(new ServerError(500, "boom"))).toBe("The server had a problem (500). It is not your fault. Try again in a moment.");
    expect(describeError(new ServerError(501, "x"))).toContain("(501)");
  });
  it("a 502/503/504 means a proxy has nothing behind it: same sentence as no server", () => {
    for (const status of [502, 503, 504]) {
      expect(describeError(new ServerError(status, "x"))).toBe(describeError(new NetworkError("unreachable")));
    }
  });
  it("a 404: shows the server's own sentence", () => {
    expect(describeError(new ServerError(404, "No such to-do."))).toBe("No such to-do.");
  });
  it("sign-in answers (401, 403, 409) show the server's own sentence", () => {
    expect(describeError(new ServerError(401, "Wrong email or password."))).toBe("Wrong email or password.");
    expect(describeError(new ServerError(403, "Only an admin can do that."))).toBe("Only an admin can do that.");
    expect(describeError(new ServerError(409, "That email is already registered. Try signing in."))).toBe("That email is already registered. Try signing in.");
  });
  it("a 422: shows what each field said", () => {
    expect(describeError(new ServerError(422, "Request failed (422).", { title: "Title cannot be empty." }))).toBe("Title cannot be empty.");
    expect(describeError(new ServerError(422, "x", { title: "A.", done: "B." }))).toBe("A. B.");
  });
  it("a 422 with no field details still says something useful", () => {
    expect(describeError(new ServerError(422, "x"))).toBe("Please check what you typed.");
  });
  it("anything else gets a plain sentence (never a blank or '[object Object]')", () => {
    expect(describeError(new Error("weird"))).toBe("Something went wrong.");
    expect(describeError("text")).toBe("Something went wrong.");
    expect(describeError(undefined)).toBe("Something went wrong.");
  });
  it("the server-error and no-server messages are different", () => {
    expect(describeError(new ServerError(500, "x"))).not.toBe(describeError(new NetworkError("unreachable")));
  });
});
```

---

## 8. Results

| Check | Command | Result |
|---|---|---|
| Backend tests | `cd backend && python -m pytest -q` | **186 passed** |
| Frontend types | `cd frontend && npx tsc --noEmit` | No errors |
| Frontend tests | `cd frontend && npx vitest run` (three runs in a row) | **125 passed** each time (7 files) |
| Real-browser check | `cd frontend && npm run proof` (real FastAPI with a 3 second token, real Vite, Chromium) | **38 of 38 passed**, in dev-proxy mode and in cross-origin mode |
| **Number 1:** three requests meet an expired token | Same check (wait for expiry, then 3 list calls at once through the app's own API module) | **1 refresh call** in the backend log, **1** seen by the browser, and all three calls returned their data. The same in cross-origin mode |
| **Number 2:** the cookie as the browser stored it | Same check (`context.cookies()`) | `refresh_token`: **HttpOnly = true**, **Path = /api/auth**, **SameSite = Strict**, **Secure = false** (plain http://localhost; on with `COOKIE_SECURE=1`), expires in **7.00 days**. The same flags in cross-origin mode |
| **Number 3:** a viewer sends DELETE by hand | Same check (`fetch` with the viewer's token) | **403** ("Only an admin can do that."). With no token: **401**. With an admin's token: **204**. The refused delete changed nothing |
| **Number 4:** what is left in storage | Same check, after sign-in and after a reload | `localStorage`: **0** items. `sessionStorage`: **0** items. `document.cookie`: **empty string**. IndexedDB: **0** databases. The access token was found in none of them |
| Cookie travels only where it should | Same check | The to-do request carried no cookie and a Bearer header. The refresh request carried the cookie |
| A reload keeps you signed in | Same check | Yes, through the refresh cookie, in both modes |
| Wrong email versus wrong password | Same check (on screen and from the server) | The same sentence on screen, and the same status and body from the server |
| Sign out | Same check | The browser's cookie is gone; a copy of the old cookie gets **401** from the server; the protected page sends you to sign in |
| Roles on screen | Same check | A viewer sees no Delete buttons; an admin sees them (screenshots in `frontend/proof/`) |
| Preflights in cross-origin mode | Same check, counted in the backend log | The browser sent a preflight for `/api/auth/signup` and for `/api/todos`: the `Authorization` header and the JSON content type each trigger one |
| Break-it checks | `python break42.py` (38 changes, each run against the right test suite) | **38 of 38 caught**. Backend (23): token decoded without checking the signature or algorithm; expiry not checked; a day-long token; cookie not HttpOnly; cookie path `/`; no SameSite; a role accepted from the client; everyone an admin; role taken from the token; plain-text password; Argon2 cost turned down; different messages for a wrong email and a wrong password; the password check skipped for an unknown email; a viewer may delete; the list readable without sign-in; no rotation; a replay does not cancel the session; sign-out does not cancel the token; refresh token stored raw; a refused refresh leaves the cookie; email case-sensitive; CORS credentials off; CORS `Authorization` off. Frontend (15): token also in `localStorage`; no single flight; a late 401 refreshes again; more than one retry; a 403 triggers a refresh; sign-in calls refresh on 401; cookie not sent cross-origin; no Authorization header; a refused refresh does not sign out; sign-out keeps the token; sign-up sends a role; Delete shown to viewers; protected page does not redirect; protected page redirects while checking; password field shows the text |
| After the break-it run | Both suites again | Original code restored, all tests green |

---

## 9. Problems avoided

| Problem | Cause | Fix |
|---|---|---|
| A refused refresh did not clear the dead cookie | When FastAPI raises an error (`HTTPException`), the headers set on the injected response are thrown away, so the `Set-Cookie` that clears the cookie never left the server. A test caught it | The refresh route returns a response object with the cookie already cleared, instead of raising |
| The first version could refresh twice for three calls | A call whose 401 arrived after the renewal had finished found no refresh in progress and started a second one. With rotation, that is not just waste: it spends a token another call may be holding | `renewToken(failedWith)` returns the current token when it is no longer the one that failed. A test holds one call back to prove it |
| The Day 41 backend tests all got 401 | Every to-do route now needs a token | The `client` fixture signs up an admin and carries its token. The 75 tests are unchanged |
| Three Day 41 tests built their own app without a token | `TestPersistence` and the OpenAPI test called the to-do routes directly or counted all paths | They sign in first, and the OpenAPI test looks only at the to-do paths |
| `credentials: "include"` could not be tested through MSW | MSW's request object always reports `same-origin`, whatever was sent | The test spies on `fetch` and checks the options. The real effect (the cookie crossing origins) is proved in the browser check |
| The first browser check failed on the admin's delete | The admin token was made at the start and the 3 second life had run out by then (the app did exactly what it should: 401) | The script signs the admin in again right before the delete |
| A stranger's preflight still carries `allow-credentials` | Starlette adds it to its 400 refusal | The test checks the part that matters: there is no `allow-origin`, so the browser blocks the call |
| PyJWT warned about the key length in the wrong-algorithm test | HS512 wants a longer key than the test secret | The test silences that one warning. The check itself (the right secret with another algorithm is refused) is unchanged |
| `StrictMode` runs effects twice | The page-load cookie check could start two refresh calls | The refresh is single-flight, and a test renders under `StrictMode` and counts one call |

---

## 10. What was practiced

- Hashing passwords with Argon2 and never storing or returning them.
- Issuing short access tokens, and decoding them with `algorithms=[...]` and required claims.
- Setting a refresh cookie with `HttpOnly`, a narrow `Path`, and an explicit `SameSite`, and proving the browser stored it that way.
- Rotating refresh tokens, storing only hashes, and cancelling a session when an old token comes back.
- Telling 401 (who are you?) from 403 (not allowed), and checking 401 first.
- Letting the server decide roles, from its own list and its own database.
- Making many requests share one refresh call, and measuring it.
- Keeping the token out of `localStorage`, and proving what is and is not in storage.
- Building `AuthProvider` and `ProtectedRoute`, with no flash of the sign-in page.
- Counting requests with `page.on("request")` and reading the server's own log.
- Breaking each rule on purpose to see whether the tests notice.

---

## 11. Known limit

Known limits of this project. **Access tokens cannot be cancelled:** after sign-out an access token still works until it expires (at most 5 minutes); that is why it is short. **There is no rate limit or lockout** on sign-in, so a password can be guessed as fast as the server answers; a real site needs one. **Sign-up reveals that an email is taken** (409), by choice. **There is no email verification and no password reset.** **Two browser tabs** share one refresh cookie: if both refresh at the very same moment, the second one carries a token the first just used, and the server cancels the session, so the person signs in again; one tab at a time is safe, and within one tab the single-flight rule prevents it. **The cookie is not `Secure` on plain http** (needed for local development); set `COOKIE_SECURE=1` behind https. **The secret** comes from `JWT_SECRET`; without it a random one is made at each start, so every token dies when the server restarts (fine for development, wrong for production). **Admins** are made only by listing an email in `ADMIN_EMAILS` before that email signs up; there is no screen to promote someone. The browser check runs in Chromium, headless, only. The hints in the task screenshot were slightly cut off.

---

## 12. How to run it

```bash
# Terminal 1: backend (set the admin email first; it becomes an admin when it signs up)
cd backend
.venv\Scripts\Activate.ps1
$env:ADMIN_EMAILS = "you@example.com"
$env:JWT_SECRET = "any-long-random-text-at-least-32-characters"
python -m uvicorn app.main:app --reload --port 8000

# Terminal 2: frontend, proxy road
cd frontend
npm run dev                # open http://localhost:5173   (or: npm run dev:cors  for the cross-origin road)

# tests
cd backend  && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run

# real browser proof (starts its own backend and Vite; stop yours first, ports 8000 and 5173 must be free)
cd frontend && npm run proof

# break each rule once on purpose (from the project folder, takes about 12 minutes)
python break42.py
```

Sign up with the email you listed in `ADMIN_EMAILS` to get an admin (Delete buttons appear). Sign up with any other email to get a viewer. API docs while the backend runs: http://localhost:8000/docs (use the Authorize button with a token from `/api/auth/signin`). On Mac or Linux, set the variables with `export ADMIN_EMAILS=you@example.com`.
