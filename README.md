# To-do App with Real Sign-in

The Day 41 to-do app (FastAPI + React + TypeScript), now behind a sign-in: Argon2 password hashing, 5-minute access tokens kept in memory, a rotating HttpOnly refresh cookie (narrow Path, SameSite=Strict), viewer and admin roles decided by the server, one request function that renews the token once, and role-aware Delete.

## Run

```bash
# Terminal 1
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1      # Mac/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
$env:ADMIN_EMAILS = "you@example.com"      # Mac/Linux: export ADMIN_EMAILS=you@example.com
python -m uvicorn app.main:app --reload --port 8000

# Terminal 2
cd frontend
npm install
npm run dev          # proxy road      (or: npm run dev:cors  for the cross-origin road)
```

Open http://localhost:5173 and create an account. The email in `ADMIN_EMAILS` becomes an admin; every other email is a viewer. API docs: http://localhost:8000/docs.

## Test

```bash
cd backend  && python -m pytest -q                  # 186 tests
cd frontend && npx tsc --noEmit && npx vitest run   # 125 tests
cd frontend && npx playwright install chromium && npm run proof   # real browser, 38 checks
python break42.py                                   # 38 deliberate mistakes, all caught
```

See `DOCUMENTATION.md` for the full write-up.
