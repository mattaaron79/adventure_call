"""Authentication helpers."""

from .models import User, make_user

SESSIONS: dict[str, User] = {}


def login_user(name: str, password: str) -> User:
    """Authenticate a user and open a session.

    Returns the freshly created :class:`User` record.
    """
    user = make_user(name)
    SESSIONS[name] = user
    return user


def logout_user(name: str) -> bool:
    """Close a session if one is open."""
    return SESSIONS.pop(name, None) is not None
