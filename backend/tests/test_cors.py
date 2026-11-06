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
