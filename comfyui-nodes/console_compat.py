"""Console helpers for environments with limited stdout encodings."""

from __future__ import annotations

import builtins
import locale
import sys


def _resolve_encoding(stream) -> str:
    return getattr(stream, "encoding", None) or locale.getpreferredencoding(False) or "utf-8"


def _sanitize_text(value, encoding: str) -> str:
    text = str(value)
    return text.encode(encoding, errors="replace").decode(encoding, errors="replace")


def safe_print(*args, **kwargs):
    """Print text without crashing when stdout cannot encode emoji/Unicode."""
    stream = kwargs.get("file") or sys.stdout
    encoding = _resolve_encoding(stream)

    kwargs["sep"] = _sanitize_text(kwargs.get("sep", " "), encoding)
    kwargs["end"] = _sanitize_text(kwargs.get("end", "\n"), encoding)

    safe_args = [_sanitize_text(arg, encoding) for arg in args]
    builtins.print(*safe_args, **kwargs)

