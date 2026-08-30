"""HTTP-ish entry points for the sample project."""

import json

import src.models as models
from src.auth import login_user as login
from src.auth import logout_user


def handle_login(payload: str) -> str:
    """Parse a payload, log the user in and describe the result."""
    data = json.loads(payload)
    user = login(data["name"], data["password"])
    admin = models.Admin(user.name, "admin")
    return admin.greet()


def handle_logout(name: str) -> bool:
    return logout_user(name)


class Router:
    """Trivial dispatcher."""

    def dispatch(self, route: str, payload: str) -> object:
        """Send a request to the right handler."""
        if route == "login":
            return handle_login(payload)
        return self.fallback(route)

    def fallback(self, route: str) -> object:
        return None
