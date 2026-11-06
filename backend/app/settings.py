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
