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
