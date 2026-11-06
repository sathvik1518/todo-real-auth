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
