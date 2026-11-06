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
