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
