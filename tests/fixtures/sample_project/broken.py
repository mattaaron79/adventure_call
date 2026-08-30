"""A file with a syntax error, to prove partial extraction works."""


def still_parses(value: int) -> int:
    """This definition is intact and must survive."""
    return value * 2


def also_parses() -> int:
    """So does this one, because the damage comes later."""
    return still_parses(21)


def broken_here(:
    x =
