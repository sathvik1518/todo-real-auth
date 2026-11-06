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
