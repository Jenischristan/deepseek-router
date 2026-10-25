#!/usr/bin/env python3
"""Extract a DeepSeek web session from a local Zen or Firefox profile.

Reads the localStorage entry `userToken` (plus optional cookies and the
`hif_leim_cached` value) without touching the browser's live databases.

Examples:
    python3 scripts/get-token.py
    python3 scripts/get-token.py --write
    python3 scripts/get-token.py --write-accounts
    python3 scripts/get-token.py --watch
    python3 scripts/get-token.py --json
    python3 scripts/get-token.py --token-only
    python3 scripts/get-token.py --list
    python3 scripts/get-token.py --profile ~/.config/zen/abcd.Default
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

DEFAULT_CONTAINER_NAMES = {
    1: "Personal",
    2: "Work",
    3: "Banking",
    4: "Shopping",
}
DEFAULT_CONTAINER_ICONS = {
    "fingerprint": "Personal",
    "briefcase": "Work",
    "dollar": "Banking",
    "cart": "Shopping",
}


@dataclass
class Profile:
    path: Path
    source: str
    token: Optional[str] = None
    hif_leim: Optional[str] = None
    ls_db: Optional[Path] = None
    active: bool = False
    mtime: float = 0.0
    error: Optional[str] = None
    cookie_names: list[str] = field(default_factory=list)
    origin_suffix: str = ""
    user_context_id: Optional[int] = None
    container_name: Optional[str] = None

    @property
    def label(self) -> str:
        if self.user_context_id is None:
            return str(self.path)
        name = self.container_name or f"container {self.user_context_id}"
        return f"{self.path} [{name}]"


def default_roots() -> list[tuple[str, Path]]:
    home = Path.home()
    roots: list[tuple[str, Path]] = []

    for variable in ("ZEN_PROFILE_DIR", "FIREFOX_PROFILE_DIR"):
        value = os.environ.get(variable)
        if value:
            roots.append((variable, Path(value).expanduser()))

    roots.extend(
        [
            ("zen", home / ".config" / "zen"),
            ("zen", home / ".zen"),
            ("zen-flatpak", home / ".var" / "app" / "app.zen_browser.zen" / ".zen"),
            ("zen-flatpak", home / ".var" / "app" / "app.zen_browser.zen" / ".config" / "zen"),
            ("zen-snap", home / "snap" / "zen-browser" / "common" / ".zen"),
            ("firefox", home / ".mozilla" / "firefox"),
            ("firefox", home / ".config" / "mozilla" / "firefox"),
            ("firefox-flatpak", home / ".var" / "app" / "org.mozilla.firefox" / ".mozilla" / "firefox"),
            ("firefox-snap", home / "snap" / "firefox" / "common" / ".mozilla" / "firefox"),
            ("waterfox", home / ".waterfox"),
            ("librewolf", home / ".librewolf"),
        ]
    )
    return roots


def is_profile_dir(path: Path) -> bool:
    try:
        if not path.is_dir():
            return False
    except OSError:
        return False
    return (
        (path / "prefs.js").is_file()
        or (path / "cookies.sqlite").is_file()
        or (path / "storage" / "default").is_dir()
    )


def profiles_from_ini(root: Path) -> list[Path]:
    ini_file = root / "profiles.ini"
    if not ini_file.is_file():
        return []

    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(ini_file, encoding="utf-8")
    except (configparser.Error, OSError, UnicodeDecodeError):
        return []

    result = []
    for section in parser.sections():
        if not section.startswith("Profile"):
            continue
        raw = parser.get(section, "Path", fallback="").strip()
        if not raw:
            continue
        relative = parser.get(section, "IsRelative", fallback="1").strip() != "0"
        path = (root / raw) if relative else Path(raw)
        result.append(path.expanduser())
    return result


def iter_profiles(roots: Iterable[tuple[str, Path]]):
    seen: set[str] = set()

    for source, root in roots:
        root = root.expanduser()
        if not root.is_dir():
            continue

        candidates: list[Path] = []
        if is_profile_dir(root):
            candidates.append(root)

        try:
            children = sorted(root.iterdir())
        except OSError:
            children = []

        for child in children:
            if child.is_dir() and is_profile_dir(child):
                candidates.append(child)

        candidates.extend(profiles_from_ini(root))

        for candidate in candidates:
            try:
                key = str(candidate.resolve())
            except OSError:
                key = str(candidate)
            if key in seen:
                continue
            if not is_profile_dir(candidate):
                continue
            seen.add(key)
            yield Profile(path=candidate, source=source)


def origin_user_context_id(origin_name: str) -> Optional[int]:
    """Extract `userContextId` from a storage origin or cookie attributes."""
    match = re.search(r"userContextId=(\d+)", origin_name)
    if not match:
        return None
    value = int(match.group(1))
    return value if value != 0 else None


def find_ls_contexts(profile: Path) -> list[tuple[Path, str, Optional[int]]]:
    """Every DeepSeek localStorage DB in a profile, one per container."""
    storage = profile / "storage"
    if not storage.is_dir():
        return []

    results: list[tuple[Path, str, Optional[int]]] = []
    seen: set[str] = set()

    for group in ("default", "temporary", "permanent"):
        base = storage / group
        if not base.is_dir():
            continue
        try:
            origins = list(base.iterdir())
        except OSError:
            continue
        for origin in origins:
            if not origin.is_dir() or "deepseek" not in origin.name.lower():
                continue
            db = origin / "ls" / "data.sqlite"
            if not db.is_file():
                continue
            key = str(db)
            if key in seen:
                continue
            seen.add(key)
            suffix = ""
            if "^" in origin.name:
                suffix = "^" + origin.name.split("^", 1)[1]
            results.append((db, suffix, origin_user_context_id(origin.name)))

    results.sort(key=lambda item: (item[2] is not None, item[2] or 0))
    return results


def read_container_names(profile: Path) -> dict[int, str]:
    path = profile / "containers.json"
    if not path.is_file():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}

    names: dict[int, str] = {}
    for identity in data.get("identities", []):
        if not isinstance(identity, dict) or identity.get("public") is False:
            continue
        user_context_id = identity.get("userContextId")
        if not isinstance(user_context_id, int):
            continue
        name = identity.get("name") or identity.get("l10nId") or ""
        if isinstance(name, str) and name.startswith("user-context-"):
            name = name[len("user-context-") :].replace("-", " ").title()
        if not name:
            name = DEFAULT_CONTAINER_NAMES.get(user_context_id) or DEFAULT_CONTAINER_ICONS.get(
                identity.get("icon"), ""
            )
        if name:
            names[user_context_id] = name
    return names


def open_copy(path: Path, tempdir: Path) -> sqlite3.Connection:
    """Open a private snapshot of a potentially live SQLite DB.

    Zen keeps its localStorage database locked while running, so a read-only
    connection can fail. Copying the file (plus the WAL, when present) is safe
    and gives a usable snapshot without touching the live database.
    """
    subdir = Path(tempfile.mkdtemp(dir=str(tempdir)))
    dest = subdir / (path.name or "db.sqlite")

    last_error: Optional[Exception] = None

    for _ in range(4):
        connection: Optional[sqlite3.Connection] = None
        try:
            shutil.copy2(path, dest)
            wal = path.with_name(path.name + "-wal")
            if wal.is_file():
                shutil.copy2(wal, dest.with_name(dest.name + "-wal"))

            connection = sqlite3.connect(str(dest), timeout=5)
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
            return connection
        except (OSError, sqlite3.Error) as exc:
            last_error = exc
            if connection is not None:
                try:
                    connection.close()
                except sqlite3.Error:
                    pass
            for candidate in (
                dest,
                dest.with_name(dest.name + "-wal"),
                dest.with_name(dest.name + "-shm"),
            ):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            time.sleep(0.25)

    raise RuntimeError(f"could not read {path}: {last_error}") from last_error


def unwrap_value(text: Optional[str]) -> Optional[str]:
    if not isinstance(text, str):
        return None

    text = text.strip("\x00")
    if not text:
        return None

    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text

    for _ in range(4):
        if isinstance(obj, dict) and isinstance(obj.get("value"), str):
            candidate = obj["value"]
            stripped = candidate.lstrip()
            if stripped.startswith("{") or stripped.startswith('"'):
                try:
                    obj = json.loads(candidate)
                    continue
                except json.JSONDecodeError:
                    return candidate or None
            return candidate or None
        if isinstance(obj, str):
            return obj or None
        break

    return None


def decode_lsng(value, conversion_type, compression_type) -> Optional[str]:
    if isinstance(value, str):
        text = value
    else:
        compression_type = int(compression_type or 0)
        conversion_type = int(conversion_type if conversion_type is not None else 1)

        if compression_type != 0:
            raise ValueError(
                f"localStorage value is compressed (compression_type={compression_type}); "
                "cannot decode without Snappy"
            )

        data = bytes(value)
        if conversion_type == 0:
            text = data.decode("utf-16-le", errors="replace")
        elif conversion_type == 1:
            text = data.decode("utf-8", errors="replace")
        else:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                text = data.decode("utf-16-le", errors="replace")

    return unwrap_value(text)


def read_ls_keys(db_path: Path, keys: tuple[str, ...], tempdir: Path) -> dict[str, str]:
    connection = open_copy(db_path, tempdir)
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "data" not in tables:
            return {}

        result: dict[str, str] = {}
        for key in keys:
            row = connection.execute(
                "SELECT value, conversion_type, compression_type FROM data WHERE key = ?",
                (key,),
            ).fetchone()
            if row is None:
                continue
            decoded = decode_lsng(row[0], row[1], row[2])
            if decoded:
                result[key] = decoded
        return result
    finally:
        connection.close()


def decode_legacy_value(value) -> str:
    if isinstance(value, str):
        return value

    raw = bytes(value)
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le", errors="replace")
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", errors="replace")
    if len(raw) % 2 == 0 and raw.count(b"\x00") >= max(1, len(raw) // 4):
        return raw.decode("utf-16-le", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-16-le", errors="replace")


def read_legacy_token(profile: Path, tempdir: Path) -> Optional[str]:
    db_path = profile / "webappsstore.sqlite"
    if not db_path.is_file():
        return None

    try:
        connection = open_copy(db_path, tempdir)
    except Exception:
        return None

    try:
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        except sqlite3.DatabaseError:
            return None

        for table in ("webappsstore2", "webappsstore"):
            if table not in tables:
                continue
            try:
                row = connection.execute(
                    f"SELECT value FROM {table} "
                    "WHERE key = ? AND originKey LIKE ? LIMIT 1",
                    ("userToken", "%deepseek.com%"),
                ).fetchone()
            except sqlite3.DatabaseError:
                continue
            if row is not None and row[0] is not None:
                token = unwrap_value(decode_legacy_value(row[0]))
                if token:
                    return token
        return None
    finally:
        connection.close()


def read_cookies(
    profile: Path, tempdir: Path, user_context_id: Optional[int] = None
) -> tuple[list[str], str]:
    db_path = profile / "cookies.sqlite"
    if not db_path.is_file():
        return [], ""

    connection = open_copy(db_path, tempdir)
    try:
        try:
            rows = connection.execute(
                "SELECT name, value, originAttributes FROM moz_cookies "
                "WHERE host LIKE ? OR host LIKE ?",
                ("%deepseek.com", "%chat.deepseek.com"),
            ).fetchall()
        except sqlite3.DatabaseError:
            try:
                rows = connection.execute(
                    "SELECT name, value, '' FROM moz_cookies "
                    "WHERE host LIKE ? OR host LIKE ?",
                    ("%deepseek.com", "%chat.deepseek.com"),
                ).fetchall()
            except sqlite3.DatabaseError:
                return [], ""
    finally:
        connection.close()

    rows = [
        row
        for row in rows
        if origin_user_context_id(row[2] or "") == user_context_id
    ]
    rows.sort(key=lambda row: (0 if row[0] == "smidV2" else 1, row[0]))
    names = [row[0] for row in rows if row[0]]
    cookie_header = "; ".join(
        f"{name}={value}" for name, value, _ in rows if name and value is not None
    )
    return names, cookie_header


def process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def profile_is_active(profile: Path) -> bool:
    lock = profile / "lock"
    if os.path.lexists(lock):
        try:
            target = os.readlink(lock)
        except OSError:
            return True
        match = re.search(r"\+(\d+)", target)
        if match:
            return process_is_alive(int(match.group(1)))
        return True

    return (profile / ".parentlock").exists() or (profile / "parent.lock").exists()


def analyze_profile(profile: Profile, tempdir: Path) -> list[Profile]:
    """One Profile per DeepSeek container context in this browser profile."""
    profile.active = profile_is_active(profile.path)

    contexts = find_ls_contexts(profile.path)
    container_names = read_container_names(profile.path)

    shared_mtimes = []
    for candidate in (profile.path / "cookies.sqlite", profile.path / "prefs.js"):
        try:
            shared_mtimes.append(candidate.stat().st_mtime)
        except OSError:
            pass

    results: list[Profile] = []
    first_context: Optional[Profile] = None
    seen_tokens: set[str] = set()

    for db, suffix, user_context_id in contexts:
        context = Profile(
            path=profile.path,
            source=profile.source,
            active=profile.active,
            ls_db=db,
            origin_suffix=suffix,
            user_context_id=user_context_id,
            container_name=container_names.get(user_context_id),
        )
        if first_context is None:
            first_context = context

        mtimes = list(shared_mtimes)
        try:
            mtimes.append(db.stat().st_mtime)
        except OSError:
            pass
        context.mtime = max(mtimes, default=0.0)

        try:
            values = read_ls_keys(db, ("userToken", "hif_leim_cached"), tempdir)
            context.token = values.get("userToken")
            context.hif_leim = values.get("hif_leim_cached")
        except Exception as exc:
            context.error = f"{db}: {exc}"

        if context.token and context.token not in seen_tokens:
            seen_tokens.add(context.token)
            results.append(context)

    if results:
        return results

    if first_context is not None:
        legacy = read_legacy_token(profile.path, tempdir)
        if legacy:
            first_context.token = legacy
        return [first_context]

    legacy = read_legacy_token(profile.path, tempdir)
    if legacy:
        profile.token = legacy
    profile.mtime = max(shared_mtimes, default=0.0)
    return [profile]


def choose_profile(profiles: list[Profile]) -> Optional[Profile]:
    with_token = [profile for profile in profiles if profile.token]
    if not with_token:
        return None
    with_token.sort(key=lambda profile: (profile.active, profile.mtime), reverse=True)
    return with_token[0]


def select_accounts(profiles: list[Profile]) -> list[Profile]:
    """Every profile with a token, active/newest first, deduplicated by token."""
    with_token = [profile for profile in profiles if profile.token]
    with_token.sort(key=lambda profile: (profile.active, profile.mtime), reverse=True)

    result: list[Profile] = []
    seen: set[str] = set()
    for profile in with_token:
        if profile.token in seen:
            continue
        seen.add(profile.token)
        result.append(profile)
    return result


def account_details(
    profile: Profile, tempdir: Path, *, include_cookies: bool, include_hif: bool
) -> dict:
    cookie_names: list[str] = []
    cookie_header = ""

    if include_cookies:
        try:
            cookie_names, cookie_header = read_cookies(
                profile.path, tempdir, profile.user_context_id
            )
            profile.cookie_names = cookie_names
        except Exception as exc:
            print(
                f"warning: could not read cookies for {profile.label}: {exc}",
                file=sys.stderr,
            )

    return {
        "profile": profile.label,
        "active": profile.active,
        "token": profile.token,
        "cookies": cookie_header,
        "cookieNames": cookie_names,
        "hifLeim": (profile.hif_leim or "") if include_hif else "",
        "extractedAt": datetime.now(timezone.utc).isoformat(),
    }


def config_account(details: dict) -> dict:
    account = {"token": details["token"]}
    if details["cookies"]:
        account["cookies"] = details["cookies"]
    if details["hifLeim"]:
        account["hifLeim"] = details["hifLeim"]
    return account


def config_account_token(entry) -> Optional[str]:
    if isinstance(entry, str):
        return entry or None
    if isinstance(entry, dict):
        token = entry.get("token")
        return token if isinstance(token, str) and token else None
    return None


def mask_token(token: str) -> str:
    if len(token) <= 20:
        return token[:4] + "..." + token[-4:]
    return token[:8] + "..." + token[-6:]


def default_config_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return base / "deepseek-router" / "config.json"


def load_config(path: Path) -> dict:
    path = path.expanduser()
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def save_config(path: Path, current: dict) -> None:
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass

    current["updatedAt"] = datetime.now(timezone.utc).isoformat()

    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(current, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass


def write_config(path: Path, patch: dict, remove: Iterable[str] = ()) -> None:
    current = load_config(path)
    current.update(patch)
    for key in remove:
        current.pop(key, None)
    save_config(path, current)


def upsert_config_account(path: Path, account: dict) -> tuple[int, bool]:
    """Add or refresh one account in the config's `accounts` array.

    Returns (1-based position, changed). The legacy top-level token/cookies/
    hifLeim keys are migrated into `accounts` and then removed.
    """
    current = load_config(path)
    entries = current.get("accounts")
    if not isinstance(entries, list):
        entries = []

    normalized: list[dict] = []
    seen_tokens: set[str] = set()
    for entry in entries:
        token = config_account_token(entry)
        if not token or token in seen_tokens:
            continue
        seen_tokens.add(token)
        normalized.append({"token": token} if isinstance(entry, str) else dict(entry))

    if not normalized:
        legacy_token = config_account_token(current)
        if legacy_token:
            legacy = {"token": legacy_token}
            if isinstance(current.get("cookies"), str) and current["cookies"]:
                legacy["cookies"] = current["cookies"]
            if isinstance(current.get("hifLeim"), str) and current["hifLeim"]:
                legacy["hifLeim"] = current["hifLeim"]
            normalized.append(legacy)

    index = next(
        (
            position
            for position, entry in enumerate(normalized)
            if entry["token"] == account["token"]
        ),
        -1,
    )

    changed = False
    if index == -1:
        normalized.append(account)
        index = len(normalized) - 1
        changed = True
    else:
        existing = normalized[index]
        for key in ("cookies", "hifLeim"):
            value = account.get(key)
            if value and existing.get(key) != value:
                existing[key] = value
                changed = True

    current["accounts"] = normalized
    current.pop("token", None)
    current.pop("cookies", None)
    current.pop("hifLeim", None)

    if changed:
        save_config(path, current)
    return index + 1, changed


def print_accounts(accounts: list[dict]) -> None:
    print(f"{'#':<3} {'active':<7} {'cookies':<8} {'hif':<5} {'token':<20} profile")
    for index, account in enumerate(accounts, 1):
        print(
            f"{index:<3} "
            f"{'yes' if account['active'] else 'no':<7} "
            f"{len(account['cookieNames']):<8} "
            f"{'yes' if account['hifLeim'] else 'no':<5} "
            f"{mask_token(account['token']):<20} "
            f"{account['profile']}"
        )


def print_no_token_error(profiles: list[Profile]) -> None:
    print("No DeepSeek token found in any local browser profile.", file=sys.stderr)
    for profile in profiles:
        if profile.error:
            print(f"  {profile.label}: {profile.error}", file=sys.stderr)
    print(
        "\nLog in to https://chat.deepseek.com in Zen, then run this again.",
        file=sys.stderr,
    )
    print(
        "Tip: keep each account in its own Firefox/Zen container to stay "
        "logged in to several accounts at once.",
        file=sys.stderr,
    )
    print(
        "If your profile is in a non-standard location, pass --profile PATH.",
        file=sys.stderr,
    )


def print_table(profiles: list[Profile]) -> None:
    print(f"{'active':<7} {'token':<6} {'hif':<5} {'modified':<17} profile/container")
    for profile in sorted(
        profiles, key=lambda item: (item.active, item.mtime), reverse=True
    ):
        modified = (
            datetime.fromtimestamp(profile.mtime).strftime("%Y-%m-%d %H:%M")
            if profile.mtime
            else "-"
        )
        print(
            f"{'yes' if profile.active else 'no':<7} "
            f"{'yes' if profile.token else 'no':<6} "
            f"{'yes' if profile.hif_leim else 'no':<5} "
            f"{modified:<17} {profile.label}"
        )
        if profile.error:
            print(f"        error: {profile.error}")


def discover_profiles(profile_args: list[str], root_args: list[str]) -> list[Profile]:
    if profile_args:
        return [
            Profile(path=Path(path).expanduser(), source="cli")
            for path in profile_args
        ]
    roots = [(f"cli:{root}", Path(root)) for root in root_args]
    roots.extend(default_roots())
    return list(iter_profiles(roots))


def watch_accounts(args, config_path: Path) -> int:
    include_cookies = not args.no_cookies
    include_hif = not args.no_hif
    seen: set[str] = set()

    current = load_config(config_path)
    entries = current.get("accounts")
    if isinstance(entries, list):
        for entry in entries:
            token = config_account_token(entry)
            if token:
                seen.add(token)
    legacy = config_account_token(current)
    if legacy:
        seen.add(legacy)

    if not args.quiet:
        print(
            "Watching for DeepSeek logins. Log into each account in the browser;\n"
            f"new accounts are appended to {config_path}. Press Ctrl+C when done.",
            file=sys.stderr,
        )

    count = len(seen)
    warned_no_profiles = False

    try:
        while True:
            tempdir = Path(tempfile.mkdtemp(prefix="deepseek-router-watch-"))
            try:
                profiles = discover_profiles(args.profile, args.root)
                if not profiles and not warned_no_profiles and not args.quiet:
                    print(
                        "No browser profiles found yet; still watching...",
                        file=sys.stderr,
                    )
                    warned_no_profiles = True

                for profile in (
                    context
                    for item in profiles
                    for context in analyze_profile(item, tempdir)
                ):
                    if not profile.token or profile.token in seen:
                        continue

                    details = account_details(
                        profile,
                        tempdir,
                        include_cookies=include_cookies,
                        include_hif=include_hif,
                    )
                    position, changed = upsert_config_account(
                        config_path, config_account(details)
                    )
                    seen.add(profile.token)

                    if changed:
                        count += 1
                        print(
                            f"captured account {position}: {profile.label} "
                            f"(token {mask_token(profile.token)}, "
                            f"cookies {'yes' if details['cookies'] else 'no'}, "
                            f"hif {'yes' if details['hifLeim'] else 'no'})",
                            file=sys.stderr,
                        )
            finally:
                shutil.rmtree(tempdir, ignore_errors=True)

            time.sleep(max(0.5, args.interval))
    except KeyboardInterrupt:
        if not args.quiet:
            print(
                f"\nStopped. {count} account(s) saved to {config_path}.",
                file=sys.stderr,
            )
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract a DeepSeek web token from a local Zen/Firefox profile.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The browser may stay open. Databases are read from a private copy.\n"
            "Use --write for one session, --write-accounts to save every profile and\n"
            "container with a token, or --watch to capture accounts as you switch."
        ),
    )
    parser.add_argument(
        "--profile",
        action="append",
        default=[],
        metavar="PATH",
        help="profile directory to read (repeatable; skips auto-discovery)",
    )
    parser.add_argument(
        "--root",
        action="append",
        default=[],
        metavar="PATH",
        help="additional browser root directory to scan (repeatable)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the result as JSON (includes the token and cookies)",
    )
    parser.add_argument(
        "--token-only",
        action="store_true",
        help="print only the token",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="write the session to the router config file",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="use every profile/container that contains a token (deduplicated)",
    )
    parser.add_argument(
        "--write-accounts",
        action="store_true",
        help="write every token-bearing profile/container as an accounts array (implies --all --write)",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="keep scanning and append each new account you log into (implies --write)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="watch poll interval in seconds (default: 2)",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="config path for --write (default: ~/.config/deepseek-router/config.json)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="list discovered profiles/containers and whether they contain a token",
    )
    parser.add_argument(
        "--no-cookies",
        action="store_true",
        help="do not include cookies in output or config",
    )
    parser.add_argument(
        "--no-hif",
        action="store_true",
        help="do not include the hif_leim value in output or config",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="suppress informational output",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.json and args.token_only:
        parser.error("--json and --token-only cannot be used together")

    if args.write_accounts:
        args.all = True
        args.write = True

    if args.watch:
        if args.json or args.token_only or args.list:
            parser.error(
                "--watch cannot be combined with --json, --token-only, or --list"
            )
        args.write = True

    if args.interval < 0.5:
        parser.error("--interval must be at least 0.5 seconds")

    config_path = (
        Path(args.config).expanduser() if args.config else default_config_path()
    )

    if args.watch:
        return watch_accounts(args, config_path)

    tempdir = Path(tempfile.mkdtemp(prefix="deepseek-router-"))

    try:
        if args.profile:
            profiles = [
                Profile(path=Path(path).expanduser(), source="cli")
                for path in args.profile
            ]
            roots = []
        else:
            roots = [(f"cli:{root}", Path(root)) for root in args.root]
            roots.extend(default_roots())
            profiles = list(iter_profiles(roots))

        if not profiles:
            print(
                "No Zen/Firefox profiles found. Checked:\n  "
                + "\n  ".join(str(root) for _, root in roots),
                file=sys.stderr,
            )
            return 1

        analyzed = [
            context
            for profile in profiles
            for context in analyze_profile(profile, tempdir)
        ]

        if args.list:
            print_table(analyzed)
            return 0 if any(profile.token for profile in analyzed) else 1

        if args.all:
            selected = select_accounts(analyzed)
            if not selected:
                print_no_token_error(analyzed)
                return 1

            details = [
                account_details(
                    profile,
                    tempdir,
                    include_cookies=not args.no_cookies,
                    include_hif=not args.no_hif,
                )
                for profile in selected
            ]

            if args.write:
                write_config(
                    config_path,
                    {"accounts": [config_account(item) for item in details]},
                    remove=("token", "cookies", "hifLeim"),
                )

            if args.token_only:
                for account in details:
                    print(account["token"])
                return 0

            if args.json:
                print(json.dumps({"accounts": details}, indent=2))
                return 0

            if not args.quiet:
                print_accounts(details)
                if args.write:
                    print(
                        f"\nConfig:  {config_path} "
                        f"(mode 600, {len(details)} account(s))"
                    )
                else:
                    print(
                        "\nConfig:  not written "
                        "(add --write or use --write-accounts)"
                    )

            return 0

        best = choose_profile(analyzed)

        if best is None:
            print_no_token_error(analyzed)
            return 1

        if not best.active and not args.quiet:
            print(
                f"warning: selected session is not currently active: {best.label}",
                file=sys.stderr,
            )

        token_profiles = [profile for profile in analyzed if profile.token]
        if len(token_profiles) > 1 and not args.quiet:
            print(
                f"warning: {len(token_profiles)} sessions contain a DeepSeek token; "
                f"using {best.label}",
                file=sys.stderr,
            )
            for profile in token_profiles:
                if profile is not best:
                    print(f"         also: {profile.label}", file=sys.stderr)

        payload = account_details(
            best,
            tempdir,
            include_cookies=not args.no_cookies,
            include_hif=not args.no_hif,
        )
        cookie_names = payload["cookieNames"]
        cookie_header = payload["cookies"]
        hif_leim = payload["hifLeim"]

        if args.write:
            existing = load_config(config_path)
            existing_accounts = existing.get("accounts")
            if isinstance(existing_accounts, list) and existing_accounts:
                account = {"token": best.token}
                if cookie_header:
                    account["cookies"] = cookie_header
                if hif_leim:
                    account["hifLeim"] = hif_leim
                position, _ = upsert_config_account(config_path, account)
                if not args.quiet:
                    print(
                        f"note: config uses accounts; saved as account {position}. "
                        "Use --write-accounts to rebuild the full queue.",
                        file=sys.stderr,
                    )
            else:
                patch = {"token": best.token}
                if cookie_header:
                    patch["cookies"] = cookie_header
                if hif_leim:
                    patch["hifLeim"] = hif_leim
                write_config(config_path, patch)

        if args.token_only:
            print(best.token)
            return 0

        if args.json:
            print(json.dumps(payload, indent=2))
            return 0

        if not args.quiet:
            print(f"Profile: {best.label}")
            print(
                f"Token:   {mask_token(best.token)} "
                f"({len(best.token)} chars)"
            )
            if args.no_cookies:
                print("Cookies: (skipped)")
            elif cookie_names:
                print(f"Cookies: {', '.join(cookie_names)} ({len(cookie_names)})")
            else:
                print("Cookies: (none found; token alone is usually enough)")
            if args.no_hif:
                print("HIF:     (skipped)")
            else:
                print(f"HIF:     {'yes' if hif_leim else 'no'}")
            if args.write:
                print(f"Config:  {config_path} (mode 600)")
            else:
                print("Config:  not written (use --write to save)")

        return 0
    finally:
        shutil.rmtree(tempdir, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
