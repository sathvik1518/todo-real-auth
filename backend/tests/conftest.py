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
