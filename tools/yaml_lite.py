"""ArenaMugen YAML Profile stdlib parser, serializer, and canonical JSON helper."""

from __future__ import annotations

import json
import re
from typing import Any

INT_RE = re.compile(r"^[-+]?[0-9]+$")
FLOAT_RE = re.compile(r"^[-+]?[0-9]+\.[0-9]+$")

YAML_1_1_TRAPS_EXACT = {
    "yes", "Yes", "YES",
    "no", "No", "NO",
    "on", "On", "ON",
    "off", "Off", "OFF",
    "y", "Y", "n", "N",
    "~", "Null", "NULL",
    "True", "TRUE", "False", "FALSE",
    ".inf", "-.inf", "+.inf", ".Inf", ".INF",
    ".nan", ".NaN", ".NAN",
}

YAML_1_1_TRAP_PATTERNS = [
    re.compile(r"^[-+]?0[xXoObB][0-9a-fA-F_]+$"),          # hex/octal/binary
    re.compile(r"^[-+]?[0-9][0-9_]*_[0-9_]+(\.[0-9_]+)?$"), # numeric underscores
    re.compile(r"^[-+]?[0-9]+(:[0-5]?[0-9])+(\.[0-9]+)?$"), # sexagesimal 1:30
    re.compile(r"^[-+]?\.[0-9]+([eE][-+]?[0-9]+)?$"),       # leading-dot float .5
    re.compile(r"^[-+]?[0-9]+\.([eE][-+]?[0-9]+)?$"),       # trailing-dot float 5.
    re.compile(r"^[-+]?[0-9]+(\.[0-9]+)?[eE][-+]?[0-9]+$"), # scientific 1e3
]


class YamlLiteError(ValueError):
    """Raised when input violates the ArenaMugen YAML profile."""


def _strip_comment(line: str) -> str:
    in_quotes = False
    escape = False
    for idx, ch in enumerate(line):
        if escape:
            escape = False
            continue
        if ch == "\\":
            if in_quotes:
                escape = True
            continue
        if ch == '"':
            in_quotes = not in_quotes
            continue
        if ch == "#" and not in_quotes:
            if idx == 0 or line[idx - 1].isspace():
                return line[:idx].rstrip()
    if in_quotes:
        raise YamlLiteError(f"Unterminated double quote in line: {line!r}")
    return line.rstrip()


def parse_scalar(token: str) -> Any:
    token = token.strip()
    if not token:
        raise YamlLiteError("Empty scalar token is not allowed")
    if token[0] in ("&", "*", "!", "|", ">"):
        raise YamlLiteError(f"Unsupported YAML feature in token: {token!r}")
    if token.startswith('"'):
        if not token.endswith('"') or len(token) < 2:
            raise YamlLiteError(f"Malformed double-quoted string: {token!r}")
        inner = token[1:-1]
        out: list[str] = []
        i = 0
        while i < len(inner):
            ch = inner[i]
            if ch == "\\":
                if i + 1 >= len(inner):
                    raise YamlLiteError(f"Trailing backslash in quoted scalar: {token!r}")
                nxt = inner[i + 1]
                if nxt in ('"', "\\"):
                    out.append(nxt)
                elif nxt == "n":
                    out.append("\n")
                elif nxt == "t":
                    out.append("\t")
                else:
                    raise YamlLiteError(f"Unsupported escape \\{nxt} in {token!r}")
                i += 2
            elif ch == '"':
                raise YamlLiteError(f"Unescaped quote inside scalar: {token!r}")
            else:
                out.append(ch)
                i += 1
        return "".join(out)
    if token.startswith("'"):
        raise YamlLiteError(f"Single-quoted scalars are not in the ArenaMugen YAML profile: {token!r}")
    if token in ("true", "false"):
        return token == "true"
    if token == "null":
        return None
    if token in YAML_1_1_TRAPS_EXACT:
        raise YamlLiteError(f"Ambiguous YAML 1.1 scalar rejected: {token!r}")
    for pat in YAML_1_1_TRAP_PATTERNS:
        if pat.match(token):
            raise YamlLiteError(f"Ambiguous YAML 1.1 numeric/time trap rejected: {token!r}")
    if INT_RE.match(token):
        return int(token)
    if FLOAT_RE.match(token):
        return float(token)
    return token


def _parse_flow_seq(token: str) -> list[Any]:
    inner = token[1:-1].strip()
    if not inner:
        return []
    items: list[Any] = []
    cur: list[str] = []
    in_quotes = False
    escape = False
    for ch in inner:
        if escape:
            cur.append(ch)
            escape = False
            continue
        if ch == "\\" and in_quotes:
            cur.append(ch)
            escape = True
            continue
        if ch == '"':
            in_quotes = not in_quotes
            cur.append(ch)
            continue
        if ch == "," and not in_quotes:
            raw = "".join(cur).strip()
            if not raw:
                raise YamlLiteError(f"Empty element in flow sequence: {token!r}")
            if raw.startswith("[") or raw.startswith("{"):
                raise YamlLiteError(f"Nested flow collections not supported: {token!r}")
            items.append(parse_scalar(raw))
            cur = []
        else:
            cur.append(ch)
    raw = "".join(cur).strip()
    if not raw:
        raise YamlLiteError(f"Trailing comma in flow sequence: {token!r}")
    if raw.startswith("[") or raw.startswith("{"):
        raise YamlLiteError(f"Nested flow collections not supported: {token!r}")
    items.append(parse_scalar(raw))
    return items


def load(text: str) -> Any:
    raw_lines = text.splitlines()
    cleaned: list[tuple[int, str]] = []
    for line_no, raw in enumerate(raw_lines, start=1):
        if "\t" in raw:
            raise YamlLiteError(f"Line {line_no}: Tab indentation is forbidden")
        stripped_check = raw.strip()
        if stripped_check in ("---", "..."):
            raise YamlLiteError(f"Line {line_no}: Multi-document markers are forbidden")
        no_comment = _strip_comment(raw)
        if not no_comment.strip():
            continue
        indent = len(no_comment) - len(no_comment.lstrip(" "))
        if indent % 2 != 0:
            raise YamlLiteError(f"Line {line_no}: Indentation must be a multiple of 2 spaces (got {indent})")
        cleaned.append((indent, no_comment.strip()))

    if not cleaned:
        raise YamlLiteError("Empty YAML document")

    idx = 0

    def parse_block(expected_indent: int) -> Any:
        nonlocal idx
        if idx >= len(cleaned):
            raise YamlLiteError("Unexpected end of YAML input")
        first_indent, first_content = cleaned[idx]
        if first_indent != expected_indent:
            raise YamlLiteError(f"Expected indent {expected_indent}, got {first_indent} at {first_content!r}")

        if first_content.startswith("- ") or first_content == "-":
            seq: list[Any] = []
            while idx < len(cleaned):
                indent, content = cleaned[idx]
                if indent < expected_indent:
                    break
                if indent > expected_indent:
                    raise YamlLiteError(f"Unexpected indent {indent} in sequence at {content!r}")
                if not (content.startswith("- ") or content == "-"):
                    break
                idx += 1
                item_str = content[1:].strip()
                if not item_str:
                    seq.append(parse_block(expected_indent + 2))
                elif item_str.startswith("[") and item_str.endswith("]"):
                    seq.append(_parse_flow_seq(item_str))
                else:
                    seq.append(parse_scalar(item_str))
            return seq

        mapping: dict[str, Any] = {}
        while idx < len(cleaned):
            indent, content = cleaned[idx]
            if indent < expected_indent:
                break
            if indent > expected_indent:
                raise YamlLiteError(f"Unexpected indent {indent} in mapping at {content!r}")
            if content.startswith("- ") or content == "-":
                raise YamlLiteError(f"Sequence item not allowed directly inside mapping at same indent: {content!r}")
            colon_pos = content.find(":")
            if colon_pos <= 0:
                raise YamlLiteError(f"Missing key-value colon in {content!r}")
            key = content[:colon_pos].strip()
            if not re.match(r"^[A-Za-z0-9_.-]+$", key):
                raise YamlLiteError(f"Invalid mapping key: {key!r}")
            if key in mapping:
                raise YamlLiteError(f"Duplicate mapping key: {key!r}")
            val_str = content[colon_pos + 1 :].strip()
            idx += 1
            if not val_str:
                if idx >= len(cleaned) or cleaned[idx][0] <= expected_indent:
                    raise YamlLiteError(f"Key {key!r} has empty value and no indented block")
                mapping[key] = parse_block(expected_indent + 2)
            elif val_str.startswith("[") and val_str.endswith("]"):
                mapping[key] = _parse_flow_seq(val_str)
            elif val_str.startswith("{"):
                raise YamlLiteError(f"Flow mappings are not supported: {val_str!r}")
            else:
                mapping[key] = parse_scalar(val_str)
        return mapping

    result = parse_block(0)
    if idx != len(cleaned):
        raise YamlLiteError(f"Trailing unparsed content at {cleaned[idx]!r}")
    return result


def _format_scalar(val: Any, force_quote: bool = False) -> str:
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        return repr(val)
    if isinstance(val, str):
        needs_quote = (
            force_quote
            or val == ""
            or val in ("true", "false", "null")
            or val in YAML_1_1_TRAPS_EXACT
            or any(p.match(val) for p in YAML_1_1_TRAP_PATTERNS)
            or bool(INT_RE.match(val))
            or bool(FLOAT_RE.match(val))
            or any(c in val for c in (":", "#", "[", "]", "{", "}", ",", '"', "'", "\n", "\t"))
            or val[0].isspace()
            or val[-1].isspace()
            or val[0] in ("-", "?", "&", "*", "!", "|", ">")
        )
        if needs_quote:
            escaped = val.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
            return f'"{escaped}"'
        return val
    raise YamlLiteError(f"Unsupported type for YAML serialization: {type(val)}")


def dump(data: Any) -> str:
    lines: list[str] = []

    def _emit(obj: Any, indent: int) -> None:
        prefix = " " * indent
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, dict):
                    lines.append(f"{prefix}{k}:")
                    _emit(v, indent + 2)
                elif isinstance(v, list):
                    if len(v) == 0:
                        lines.append(f"{prefix}{k}: []")
                    elif all(not isinstance(x, (dict, list)) for x in v) and k in ("platforms", "approved_references", "input_hashes"):
                        inner = ", ".join(_format_scalar(x) for x in v)
                        lines.append(f"{prefix}{k}: [{inner}]")
                    else:
                        lines.append(f"{prefix}{k}:")
                        _emit(v, indent + 2)
                else:
                    force_q = k in ("spec_hash", "provider", "provider_model", "task_id", "created_at", "prompt", "uri", "hash", "checked_at", "approved_by", "approved_at", "manifest_hash", "notes", "original_brief")
                    lines.append(f"{prefix}{k}: {_format_scalar(v, force_quote=force_q)}")
        elif isinstance(obj, list):
            for item in obj:
                if isinstance(item, (dict, list)):
                    lines.append(f"{prefix}-")
                    _emit(item, indent + 2)
                else:
                    lines.append(f"{prefix}- {_format_scalar(item)}")
        else:
            lines.append(f"{prefix}{_format_scalar(obj)}")

    _emit(data, 0)
    return "\n".join(lines) + "\n"


def normalize_for_canonical_json(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {str(k): normalize_for_canonical_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [normalize_for_canonical_json(x) for x in obj]
    if isinstance(obj, float) and obj.is_integer():
        return int(obj)
    return obj


def canonical_json_bytes(obj: Any) -> bytes:
    normalized = normalize_for_canonical_json(obj)
    return json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
