"""Domain objects for the sample project."""

from dataclasses import dataclass


@dataclass
class User:
    """A person who can log in."""

    name: str
    role: str = "guest"

    def greet(self, greeting: str = "hello") -> str:
        """Return a friendly greeting for this user."""
        return self._format(greeting)

    def _format(self, greeting: str) -> str:
        return f"{greeting}, {self.name}"


class Admin(User):
    """A user with elevated privileges."""

    def greet(self, greeting: str = "hello") -> str:
        """Greet, but louder."""
        return self._format(greeting).upper()


def make_user(name: str, /, role: str = "guest", *tags: str, **extra: object) -> User:
    """Build a :class:`User`, ignoring the extra metadata."""
    return User(name, role)
