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
