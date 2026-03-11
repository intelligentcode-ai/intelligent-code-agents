#!/usr/bin/env python3
"""
ICA MCP Proxy CLI (helper)

This is optional, but useful for debugging without involving an agent runtime.

Commands:
  servers
  trust [project_path]
  trust-status [project_path]
  untrust [project_path]
  mirror-status
  token <server>
  logout <server>

Notes:
  - Trust commands are used with ICA_MCP_STRICT_TRUST=1.
  - `trust` stores trust in $ICA_HOME/mcp-trust.json (or ICA_MCP_TRUST_PATH).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path


def _import_core():
    here = Path(__file__).resolve()
    skills_dir = here.parents[2]
    bundled = here.parent / "_internal"
    common = skills_dir / "mcp-common" / "scripts"
    import sys as _sys

    for candidate in (bundled, common):
        if candidate.exists():
            resolved = str(candidate)
            if resolved not in _sys.path:
                _sys.path.append(resolved)

    try:
        from ica_mcp_core import (  # type: ignore
            delete_token_entry,
            get_project_trust_status,
            get_token_entry,
            load_servers_merged,
            token_is_expired,
            trust_path,
            trust_project,
            untrust_project,
        )

        return (
            delete_token_entry,
            get_project_trust_status,
            get_token_entry,
            load_servers_merged,
            token_is_expired,
            trust_path,
            trust_project,
            untrust_project,
        )
    except Exception as e:
        raise RuntimeError(
            "Failed to import ICA MCP core. "
            "Expected either bundled fallback at '_internal/ica_mcp_core.py' "
            "or shared 'mcp-common/scripts/ica_mcp_core.py'."
        ) from e


(
    delete_token_entry,
    get_project_trust_status,
    get_token_entry,
    load_servers_merged,
    token_is_expired,
    trust_path,
    trust_project,
    untrust_project,
) = _import_core()


def _print(data):
    print(json.dumps(data, indent=2, default=str))


def _project_from_argv() -> Path:
    if len(sys.argv) >= 3:
        return Path(sys.argv[2]).expanduser().resolve()
    return Path.cwd().resolve()


def _env_truthy(name: str) -> bool:
    return os.environ.get(name) in ("1", "true", "TRUE", "yes", "YES", "on", "ON")


async def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__.strip())
        raise SystemExit(0)

    cmd = sys.argv[1]

    if cmd == "servers":
        loaded = load_servers_merged(script_file=__file__)
        _print(
            {
                "servers": sorted(loaded.servers.keys()),
                "sources": loaded.sources,
                "blocked_servers": getattr(loaded, "blocked_servers", {}),
                "strict_trust": _env_truthy("ICA_MCP_STRICT_TRUST"),
            }
        )
        return

    if cmd == "mirror-status":
        loaded = load_servers_merged(script_file=__file__)
        _print(
            {
                "note": "Static preview only. Use proxy.mirror_status from an MCP client for runtime mirror details.",
                "servers_configured": sorted(loaded.servers.keys()),
                "blocked_servers": getattr(loaded, "blocked_servers", {}),
            }
        )
        return

    if cmd == "trust":
        project = _project_from_argv()
        out = trust_project(project, script_file=__file__)
        out["trust_store"] = str(trust_path(script_file=__file__) or "")
        _print(out)
        return

    if cmd == "trust-status":
        project = _project_from_argv()
        out = get_project_trust_status(project, script_file=__file__)
        out["trust_store"] = str(trust_path(script_file=__file__) or "")
        _print(out)
        return

    if cmd == "untrust":
        project = _project_from_argv()
        ok = untrust_project(project, script_file=__file__)
        _print(
            {
                "project": str(project),
                "status": "removed" if ok else "missing",
                "trust_store": str(trust_path(script_file=__file__) or ""),
            }
        )
        return

    if cmd == "token":
        if len(sys.argv) < 3:
            raise SystemExit("Usage: token <server>")
        s = sys.argv[2]
        entry = get_token_entry(s, script_file=__file__)
        if not entry:
            _print({"server": s, "status": "missing"})
            return
        _print(
            {
                "server": s,
                "status": "present",
                "expired": token_is_expired(entry),
                "expires_at": entry.get("expires_at"),
                "scope": entry.get("scope"),
                "token_type": entry.get("token_type"),
            }
        )
        return

    if cmd == "logout":
        if len(sys.argv) < 3:
            raise SystemExit("Usage: logout <server>")
        s = sys.argv[2]
        ok = delete_token_entry(s, script_file=__file__)
        _print({"server": s, "status": "deleted" if ok else "missing"})
        return

    raise SystemExit(f"Unknown command: {cmd}")


if __name__ == "__main__":
    asyncio.run(main())
