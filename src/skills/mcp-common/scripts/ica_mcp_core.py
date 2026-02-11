#!/usr/bin/env python3
"""
ICA MCP Core

Shared building blocks for:
- mcp-client (CLI)
- mcp-proxy (local stdio MCP server that mirrors upstream tools)

Responsibilities:
- Load/merge MCP server definitions from:
  - MCP_CONFIG (inline JSON) / MCP_CONFIG_PATH (single file override)
  - project .mcp.json
  - $ICA_HOME/mcp-servers.json / $ICA_HOME/mcp.json
  - ~/.claude.json fallback (compat only)
- Expand ${ENV_VAR} placeholders
- Token store under $ICA_HOME/mcp-tokens.json
- OAuth flows:
  - PKCE (explicit endpoints or OIDC discovery)
  - Device code (explicit endpoints or OIDC discovery)
  - Client credentials (explicit token endpoint)
- Create MCP client sessions for stdio/sse/streamable_http

This module is intentionally dependency-light (stdlib + `mcp` when used for sessions).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import threading
import urllib.parse
import urllib.request
import ipaddress
from contextlib import asynccontextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer
from typing import Any, Optional


class DependencyError(RuntimeError):
    pass


def missing_dep(dep: str, extra: str = "") -> None:
    hint = f"Missing dependency '{dep}'. Install it with: pip install {dep}"
    if extra:
        hint = f"{hint}. {extra}"
    raise DependencyError(hint)


# =============================================================================
# ICA_HOME Resolution
# =============================================================================

def get_ica_home(script_file: Optional[str] = None) -> Optional[Path]:
    """
    Resolve ICA_HOME (agent home directory).

    Priority:
    - ICA_HOME env var
    - infer from installed skill layout: <ICA_HOME>/skills/<skill>/scripts/<file>.py
    """
    if os.environ.get("ICA_HOME"):
        return Path(os.environ["ICA_HOME"]).expanduser()

    if script_file:
        p = Path(script_file).resolve()
        # .../skills/<skill>/scripts/<file>
        try:
            if p.parents[2].name == "skills":
                candidate = p.parents[3]
                # Guard: avoid treating repo layout (src/skills/...) as ICA_HOME.
                # Installed ICA homes include VERSION at the root.
                if (candidate / "VERSION").exists():
                    return candidate
        except Exception:
            return None

    return None


# =============================================================================
# Config Loading / Merging
# =============================================================================

_ENV_VAR_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


def expand_env_placeholders(value: Any) -> Any:
    """
    Best-effort `${VAR}` expansion for config values.
    - Only expands when VAR is present in the process environment.
    - Leaves unknown placeholders unchanged (so configs remain portable).
    """
    if isinstance(value, str):
        def repl(match: re.Match) -> str:
            name = match.group(1)
            return os.environ.get(name, match.group(0))

        return _ENV_VAR_PATTERN.sub(repl, value)

    if isinstance(value, list):
        return [expand_env_placeholders(v) for v in value]

    if isinstance(value, dict):
        return {k: expand_env_placeholders(v) for k, v in value.items()}

    return value


def _normalize_servers(config: dict) -> dict[str, dict[str, Any]]:
    servers = config.get("mcpServers", config)
    if not isinstance(servers, dict):
        raise ValueError("Config must be an object or contain an 'mcpServers' object.")

    filtered: dict[str, dict[str, Any]] = {}
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        if "command" in cfg or "url" in cfg:
            filtered[str(name)] = cfg
    return filtered


def _read_json_file(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _project_mcp_path(cwd: Optional[Path] = None) -> Path:
    return (cwd or Path.cwd()) / ".mcp.json"


def _ica_mcp_paths(ica_home: Optional[Path]) -> list[Path]:
    if not ica_home:
        return []
    return [ica_home / "mcp-servers.json", ica_home / "mcp.json"]


@dataclass(frozen=True)
class LoadedServers:
    servers: dict[str, dict[str, Any]]
    sources: list[str]
    server_sources: dict[str, str]
    blocked_servers: dict[str, str]
    project_root: Optional[str] = None
    project_mcp_sha256: Optional[str] = None


def _env_truthy(name: str) -> bool:
    return os.environ.get(name) in ("1", "true", "TRUE", "yes", "YES", "on", "ON")


def trust_path(*, script_file: Optional[str] = None) -> Optional[Path]:
    if os.environ.get("ICA_MCP_TRUST_PATH"):
        return Path(os.environ["ICA_MCP_TRUST_PATH"]).expanduser()
    ica_home = get_ica_home(script_file=script_file)
    if not ica_home:
        return None
    return ica_home / "mcp-trust.json"


def load_trust_store(*, script_file: Optional[str] = None) -> dict:
    path = trust_path(script_file=script_file)
    if not path or not path.exists():
        return {"version": 1, "projects": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"version": 1, "projects": {}}
        if not isinstance(data.get("projects"), dict):
            return {"version": 1, "projects": {}}
        return data
    except Exception:
        return {"version": 1, "projects": {}}


def save_trust_store(data: dict, *, script_file: Optional[str] = None) -> None:
    path = trust_path(script_file=script_file)
    if not path:
        raise ValueError("ICA_HOME is required to store trust state (set ICA_HOME or install into an agent home).")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        try:
            os.close(fd)
        except Exception:
            pass
        raise
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def project_mcp_sha256(project_root: Path) -> Optional[str]:
    p = project_root / ".mcp.json"
    if not p.exists():
        return None
    try:
        raw = p.read_bytes()
        return hashlib.sha256(raw).hexdigest()
    except Exception:
        return None


def get_project_trust_status(
    project_root: Path,
    *,
    script_file: Optional[str] = None,
) -> dict[str, Any]:
    root = str(project_root.resolve())
    current_hash = project_mcp_sha256(project_root.resolve())
    data = load_trust_store(script_file=script_file)
    entry = (data.get("projects") or {}).get(root)

    if not entry:
        return {
            "project": root,
            "trusted": False,
            "reason": "Project is not trusted for strict project stdio execution.",
            "current_mcp_sha256": current_hash,
        }

    trusted_hash = entry.get("mcp_sha256")
    if current_hash and trusted_hash and current_hash != trusted_hash:
        return {
            "project": root,
            "trusted": False,
            "reason": "Project .mcp.json changed since trust was granted.",
            "current_mcp_sha256": current_hash,
            "trusted_mcp_sha256": trusted_hash,
            "trusted_at": entry.get("trusted_at"),
        }

    return {
        "project": root,
        "trusted": True,
        "reason": "Trusted.",
        "current_mcp_sha256": current_hash,
        "trusted_mcp_sha256": trusted_hash,
        "trusted_at": entry.get("trusted_at"),
    }


def trust_project(
    project_root: Path,
    *,
    script_file: Optional[str] = None,
) -> dict[str, Any]:
    root = str(project_root.resolve())
    data = load_trust_store(script_file=script_file)
    projects = data.setdefault("projects", {})
    projects[root] = {
        "mcp_sha256": project_mcp_sha256(project_root.resolve()),
        "trusted_at": int(time.time()),
    }
    save_trust_store(data, script_file=script_file)
    return get_project_trust_status(project_root.resolve(), script_file=script_file)


def untrust_project(
    project_root: Path,
    *,
    script_file: Optional[str] = None,
) -> bool:
    root = str(project_root.resolve())
    data = load_trust_store(script_file=script_file)
    projects = data.setdefault("projects", {})
    if root in projects:
        del projects[root]
        save_trust_store(data, script_file=script_file)
        return True
    return False


def load_servers_merged(
    *,
    script_file: Optional[str] = None,
    cwd: Optional[Path] = None,
) -> LoadedServers:
    """
    Load upstream server definitions.

    Override modes:
    - MCP_CONFIG (inline JSON) => only this, no merge
    - MCP_CONFIG_PATH (path)   => only this, no merge

    Default merge:
    - project .mcp.json
    - ICA_HOME mcp-servers.json/mcp.json
    - (fallback) ~/.claude.json if neither exists

    Precedence default: project overrides ICA_HOME.
    Set ICA_MCP_CONFIG_PREFER_HOME=1 to flip.
    """
    sources: list[str] = []
    server_sources: dict[str, str] = {}
    blocked_servers: dict[str, str] = {}
    current_cwd = (cwd or Path.cwd()).resolve()

    # Inline JSON override
    if env_config := os.environ.get("MCP_CONFIG"):
        cfg = json.loads(env_config)
        servers = _normalize_servers(cfg)
        return LoadedServers(
            servers=expand_env_placeholders(servers),
            sources=["env:MCP_CONFIG"],
            server_sources={k: "env" for k in servers.keys()},
            blocked_servers={},
            project_root=str(current_cwd),
            project_mcp_sha256=project_mcp_sha256(current_cwd),
        )

    # File override
    if env_path := os.environ.get("MCP_CONFIG_PATH"):
        p = Path(env_path).expanduser()
        cfg = _read_json_file(p)
        servers = _normalize_servers(cfg)
        return LoadedServers(
            servers=expand_env_placeholders(servers),
            sources=[f"file:{str(p)}"],
            server_sources={k: "env_file" for k in servers.keys()},
            blocked_servers={},
            project_root=str(current_cwd),
            project_mcp_sha256=project_mcp_sha256(current_cwd),
        )

    merged: dict[str, dict[str, Any]] = {}

    ica_home = get_ica_home(script_file=script_file)
    project_path = _project_mcp_path(cwd=cwd)
    home_paths = _ica_mcp_paths(ica_home)

    prefer_home = os.environ.get("ICA_MCP_CONFIG_PREFER_HOME") in ("1", "true", "TRUE", "yes", "YES")

    # Load layers (if present)
    project_servers: dict[str, dict[str, Any]] = {}
    home_servers: dict[str, dict[str, Any]] = {}

    if project_path.exists():
        project_servers = _normalize_servers(_read_json_file(project_path))
        sources.append(f"file:{str(project_path)}")

    for hp in home_paths:
        if hp.exists():
            home_servers = _normalize_servers(_read_json_file(hp))
            sources.append(f"file:{str(hp)}")
            break

    # Fallback (compat only) if nothing else exists
    if not project_servers and not home_servers:
        claude = Path.home() / ".claude.json"
        if claude.exists():
            home_servers = _normalize_servers(_read_json_file(claude))
            sources.append(f"file:{str(claude)}")

    if prefer_home:
        merge_layers = [("project", project_servers), ("home", home_servers)]
    else:
        merge_layers = [("home", home_servers), ("project", project_servers)]

    for src_name, layer in merge_layers:
        for name, cfg in layer.items():
            merged[name] = cfg
            server_sources[name] = src_name

    strict_trust = _env_truthy("ICA_MCP_STRICT_TRUST")
    allow_project_stdio = _env_truthy("ICA_MCP_ALLOW_PROJECT_STDIO")
    project_root_path = project_path.parent.resolve()
    project_hash = project_mcp_sha256(project_root_path)

    if strict_trust and project_servers:
        trusted_status = get_project_trust_status(project_root_path, script_file=script_file)
        project_trusted = allow_project_stdio or bool(trusted_status.get("trusted"))

        filtered: dict[str, dict[str, Any]] = {}
        for name, cfg in merged.items():
            if server_sources.get(name) == "project" and "command" in cfg and not project_trusted:
                reason = trusted_status.get("reason") or "Project stdio server is not trusted."
                blocked_servers[name] = reason
                continue
            filtered[name] = cfg
        merged = filtered

    return LoadedServers(
        servers=expand_env_placeholders(merged),
        sources=sources,
        server_sources=server_sources,
        blocked_servers=blocked_servers,
        project_root=str(project_root_path),
        project_mcp_sha256=project_hash,
    )


# =============================================================================
# Token Store
# =============================================================================

def tokens_path(*, script_file: Optional[str] = None) -> Optional[Path]:
    ica_home = get_ica_home(script_file=script_file)
    if not ica_home:
        return None
    return ica_home / "mcp-tokens.json"


def load_tokens(*, script_file: Optional[str] = None) -> dict:
    path = tokens_path(script_file=script_file)
    if not path or not path.exists():
        return {"version": 1, "servers": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"version": 1, "servers": {}}
        if "servers" not in data or not isinstance(data.get("servers"), dict):
            return {"version": 1, "servers": {}}
        return data
    except Exception:
        return {"version": 1, "servers": {}}


def save_tokens(data: dict, *, script_file: Optional[str] = None) -> None:
    path = tokens_path(script_file=script_file)
    if not path:
        raise ValueError("ICA_HOME is required to store tokens (set ICA_HOME or install into an agent home).")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        try:
            os.close(fd)
        except Exception:
            pass
        raise
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def get_token_entry(server_name: str, *, script_file: Optional[str] = None) -> Optional[dict]:
    data = load_tokens(script_file=script_file)
    return data.get("servers", {}).get(server_name)


def set_token_entry(server_name: str, entry: dict, *, script_file: Optional[str] = None) -> None:
    data = load_tokens(script_file=script_file)
    data.setdefault("servers", {})[server_name] = entry
    save_tokens(data, script_file=script_file)


def delete_token_entry(server_name: str, *, script_file: Optional[str] = None) -> bool:
    data = load_tokens(script_file=script_file)
    servers = data.setdefault("servers", {})
    if server_name in servers:
        del servers[server_name]
        save_tokens(data, script_file=script_file)
        return True
    return False


def token_is_expired(entry: dict, skew_seconds: int = 30) -> bool:
    expires_at = entry.get("expires_at")
    if not expires_at:
        return False
    try:
        return time.time() >= float(expires_at) - skew_seconds
    except Exception:
        return False


# =============================================================================
# HTTP Helpers
# =============================================================================

def _http_json_get(url: str, headers: Optional[dict] = None, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
            return json.loads(body)
        except Exception:
            raise


def _http_form_post(url: str, data: dict, headers: Optional[dict] = None, timeout: int = 30) -> dict:
    encoded = urllib.parse.urlencode({k: v for k, v in data.items() if v is not None}).encode("utf-8")
    hdrs = {"Content-Type": "application/x-www-form-urlencoded", **(headers or {})}
    req = urllib.request.Request(url, data=encoded, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
            return json.loads(body)
        except Exception:
            raise


def _is_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
        return bool(ip.is_loopback)
    except ValueError:
        return False


def _validate_secure_url(url: str, *, field: str, allow_http_loopback: bool = False) -> None:
    parsed = urllib.parse.urlparse(str(url))
    scheme = (parsed.scheme or "").lower()
    host = parsed.hostname

    if scheme == "https":
        return
    if allow_http_loopback and scheme == "http" and _is_loopback_host(host):
        return
    raise ValueError(
        f"{field} must use https (or http only for localhost/loopback during local development)."
    )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


# =============================================================================
# OAuth
# =============================================================================

def resolve_oauth_config(server_cfg: dict) -> Optional[dict]:
    oauth = server_cfg.get("oauth")
    if not oauth or not isinstance(oauth, dict):
        return None
    return oauth


def resolve_oauth_endpoints(oauth: dict) -> dict:
    typ = str(oauth.get("type") or "pkce").lower()
    if typ.startswith("oidc"):
        issuer = oauth.get("issuer")
        if not issuer:
            raise ValueError("oauth.issuer is required for OIDC flows.")
        _validate_secure_url(str(issuer), field="oauth.issuer", allow_http_loopback=True)
        well_known = str(issuer).rstrip("/") + "/.well-known/openid-configuration"
        cfg = _http_json_get(well_known, timeout=int(oauth.get("token_timeout", 30)))
        return {
            "authorization_url": cfg.get("authorization_endpoint"),
            "token_url": cfg.get("token_endpoint"),
            "device_authorization_url": cfg.get("device_authorization_endpoint"),
        }
    return {
        "authorization_url": oauth.get("authorization_url"),
        "token_url": oauth.get("token_url"),
        "device_authorization_url": oauth.get("device_authorization_url"),
    }


class _OAuthRedirectHandler(BaseHTTPRequestHandler):
    _event: threading.Event
    _state: str
    _result: dict

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get("code") or [None])[0]
        state = (qs.get("state") or [None])[0]
        err = (qs.get("error") or [None])[0]
        desc = (qs.get("error_description") or [None])[0]

        ok = code and state == self._state and not err
        if ok:
            self._result.update({"code": code, "state": state})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Authentication complete. You can close this tab.\n")
        else:
            self._result.update({"error": err or "invalid_redirect", "error_description": desc, "state": state})
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Authentication failed. Return to the terminal.\n")

        self._event.set()

    def log_message(self, format, *args):  # noqa: A002
        return


async def oauth_auth_pkce(
    server_name: str,
    server_cfg: dict,
    *,
    script_file: Optional[str] = None,
    flow_override: Optional[str] = None,
) -> dict:
    oauth = resolve_oauth_config(server_cfg)
    if not oauth:
        raise ValueError("Server is missing oauth configuration.")

    endpoints = resolve_oauth_endpoints(oauth)
    auth_url = endpoints.get("authorization_url")
    token_url = endpoints.get("token_url")
    if not auth_url or not token_url:
        raise ValueError("OAuth PKCE requires authorization_url and token_url (or OIDC issuer).")
    _validate_secure_url(str(auth_url), field="oauth.authorization_url", allow_http_loopback=True)
    _validate_secure_url(str(token_url), field="oauth.token_url", allow_http_loopback=True)

    client_id = oauth.get("client_id")
    if not client_id:
        raise ValueError("oauth.client_id is required.")

    scopes = oauth.get("scopes") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    if not isinstance(scopes, list):
        raise ValueError("oauth.scopes must be a list of strings or a space-delimited string.")

    redirect_uri = oauth.get("redirect_uri") or "http://127.0.0.1:8765/callback"
    parsed = urllib.parse.urlparse(str(redirect_uri))
    if parsed.scheme not in ("http",):
        raise ValueError("oauth.redirect_uri must be an http:// localhost URL.")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8765
    if not _is_loopback_host(host):
        raise ValueError("oauth.redirect_uri host must be localhost or a loopback IP.")

    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)

    extra_auth_params = oauth.get("extra_auth_params") or {}
    if not isinstance(extra_auth_params, dict):
        raise ValueError("oauth.extra_auth_params must be an object.")

    params = {
        "response_type": "code",
        "client_id": str(client_id),
        "redirect_uri": str(redirect_uri),
        "scope": " ".join([str(s) for s in scopes]),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        **{str(k): str(v) for k, v in extra_auth_params.items()},
    }
    url = str(auth_url) + ("&" if "?" in str(auth_url) else "?") + urllib.parse.urlencode(params)

    event = threading.Event()
    result: dict[str, Any] = {}

    def handler_factory(*_args, **_kwargs):
        h = _OAuthRedirectHandler(*_args, **_kwargs)
        h._event = event
        h._state = state
        h._result = result
        return h

    httpd = TCPServer((host, port), handler_factory)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    try:
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass

        if not event.wait(timeout=int(oauth.get("timeout", 300))):
            raise TimeoutError("Timed out waiting for OAuth redirect.")

        if "code" not in result:
            raise ValueError(
                f"OAuth redirect error: {result.get('error')} {result.get('error_description') or ''}".strip()
            )

        code = result["code"]

        extra_token_params = oauth.get("extra_token_params") or {}
        if not isinstance(extra_token_params, dict):
            raise ValueError("oauth.extra_token_params must be an object.")

        token_req = {
            "grant_type": "authorization_code",
            "client_id": str(client_id),
            "code": code,
            "redirect_uri": str(redirect_uri),
            "code_verifier": verifier,
            **{str(k): str(v) for k, v in extra_token_params.items()},
        }
        if oauth.get("client_secret"):
            token_req["client_secret"] = str(oauth["client_secret"])

        token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))
        access = token.get("access_token")
        if not access:
            raise ValueError("Token response missing access_token.")

        expires_at = None
        try:
            if token.get("expires_in") is not None:
                expires_at = int(time.time()) + int(token["expires_in"])
        except Exception:
            expires_at = None

        entry = {
            "access_token": access,
            "refresh_token": token.get("refresh_token"),
            "token_type": token.get("token_type") or "Bearer",
            "scope": token.get("scope"),
            "expires_at": expires_at,
            "obtained_at": int(time.time()),
        }
        set_token_entry(server_name, entry, script_file=script_file)
        return {"status": "ok", "server": server_name, "auth_url": url, "saved_to": str(tokens_path(script_file=script_file) or "")}
    finally:
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:
            pass


async def oauth_auth_device_code(
    server_name: str,
    server_cfg: dict,
    *,
    script_file: Optional[str] = None,
) -> dict:
    oauth = resolve_oauth_config(server_cfg)
    if not oauth:
        raise ValueError("Server is missing oauth configuration.")

    endpoints = resolve_oauth_endpoints(oauth)
    device_url = endpoints.get("device_authorization_url")
    token_url = endpoints.get("token_url")
    if not device_url or not token_url:
        raise ValueError("OAuth device code requires device_authorization_url and token_url (or OIDC issuer).")
    _validate_secure_url(str(device_url), field="oauth.device_authorization_url", allow_http_loopback=True)
    _validate_secure_url(str(token_url), field="oauth.token_url", allow_http_loopback=True)

    client_id = oauth.get("client_id")
    if not client_id:
        raise ValueError("oauth.client_id is required.")

    scopes = oauth.get("scopes") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    if not isinstance(scopes, list):
        raise ValueError("oauth.scopes must be a list of strings or a space-delimited string.")

    req = {"client_id": str(client_id), "scope": " ".join([str(s) for s in scopes])}
    device = _http_form_post(str(device_url), req, timeout=int(oauth.get("token_timeout", 30)))
    device_code = device.get("device_code")
    user_code = device.get("user_code")
    verify_uri = device.get("verification_uri") or device.get("verification_uri_complete")
    interval = int(device.get("interval") or 5)
    expires_in = int(device.get("expires_in") or 600)

    if not device_code or not user_code or not verify_uri:
        raise ValueError("Device code response missing required fields.")

    instructions = {
        "verification_uri": device.get("verification_uri"),
        "verification_uri_complete": device.get("verification_uri_complete"),
        "user_code": user_code,
        "expires_in": expires_in,
        "interval": interval,
    }

    deadline = int(time.time()) + expires_in
    while int(time.time()) < deadline:
        token_req = {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code,
            "client_id": str(client_id),
        }
        if oauth.get("client_secret"):
            token_req["client_secret"] = str(oauth["client_secret"])
        token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))

        if token.get("access_token"):
            access = token["access_token"]
            expires_at = None
            try:
                if token.get("expires_in") is not None:
                    expires_at = int(time.time()) + int(token["expires_in"])
            except Exception:
                expires_at = None
            entry = {
                "access_token": access,
                "refresh_token": token.get("refresh_token"),
                "token_type": token.get("token_type") or "Bearer",
                "scope": token.get("scope"),
                "expires_at": expires_at,
                "obtained_at": int(time.time()),
            }
            set_token_entry(server_name, entry, script_file=script_file)
            return {
                "status": "ok",
                "server": server_name,
                "saved_to": str(tokens_path(script_file=script_file) or ""),
                "device": instructions,
            }

        err = token.get("error")
        if err == "authorization_pending":
            time.sleep(interval)
            continue
        if err == "slow_down":
            interval += 2
            time.sleep(interval)
            continue
        raise ValueError(f"Device code auth failed: {err or 'unknown_error'}")

    raise TimeoutError("Device code flow timed out.")


async def oauth_auth_client_credentials(
    server_name: str,
    server_cfg: dict,
    *,
    script_file: Optional[str] = None,
) -> dict:
    oauth = resolve_oauth_config(server_cfg)
    if not oauth:
        raise ValueError("Server is missing oauth configuration.")

    endpoints = resolve_oauth_endpoints(oauth)
    token_url = endpoints.get("token_url") or oauth.get("token_url")
    if not token_url:
        raise ValueError("client_credentials flow requires oauth.token_url (or OIDC issuer providing token_endpoint).")
    _validate_secure_url(str(token_url), field="oauth.token_url", allow_http_loopback=True)

    client_id = oauth.get("client_id")
    client_secret = oauth.get("client_secret")
    if not client_id or not client_secret:
        raise ValueError("client_credentials flow requires oauth.client_id and oauth.client_secret.")

    scopes = oauth.get("scopes") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    if scopes and not isinstance(scopes, list):
        raise ValueError("oauth.scopes must be a list of strings or a space-delimited string.")

    extra_token_params = oauth.get("extra_token_params") or {}
    if extra_token_params and not isinstance(extra_token_params, dict):
        raise ValueError("oauth.extra_token_params must be an object.")

    token_req = {
        "grant_type": "client_credentials",
        "client_id": str(client_id),
        "client_secret": str(client_secret),
        "scope": " ".join([str(s) for s in scopes]) if scopes else None,
        **{str(k): str(v) for k, v in (extra_token_params or {}).items()},
    }
    token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))

    access = token.get("access_token")
    if not access:
        raise ValueError("Token response missing access_token.")

    expires_at = None
    try:
        if token.get("expires_in") is not None:
            expires_at = int(time.time()) + int(token["expires_in"])
    except Exception:
        expires_at = None

    entry = {
        "access_token": access,
        "refresh_token": token.get("refresh_token"),
        "token_type": token.get("token_type") or "Bearer",
        "scope": token.get("scope"),
        "expires_at": expires_at,
        "obtained_at": int(time.time()),
        "grant_type": "client_credentials",
    }
    set_token_entry(server_name, entry, script_file=script_file)
    return {"status": "ok", "server": server_name, "saved_to": str(tokens_path(script_file=script_file) or "")}


def _mint_client_credentials_token(server_name: str, server_cfg: dict, *, script_file: Optional[str] = None) -> Optional[str]:
    """
    Synchronous client-credentials mint, used for automatic refresh during header injection.
    """
    oauth = resolve_oauth_config(server_cfg)
    if not oauth:
        return None
    endpoints = resolve_oauth_endpoints(oauth)
    token_url = endpoints.get("token_url") or oauth.get("token_url")
    if not token_url:
        return None
    _validate_secure_url(str(token_url), field="oauth.token_url", allow_http_loopback=True)

    client_id = oauth.get("client_id")
    client_secret = oauth.get("client_secret")
    if not client_id or not client_secret:
        return None

    scopes = oauth.get("scopes") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    if scopes and not isinstance(scopes, list):
        return None

    extra_token_params = oauth.get("extra_token_params") or {}
    if extra_token_params and not isinstance(extra_token_params, dict):
        return None

    token_req = {
        "grant_type": "client_credentials",
        "client_id": str(client_id),
        "client_secret": str(client_secret),
        "scope": " ".join([str(s) for s in scopes]) if scopes else None,
        **{str(k): str(v) for k, v in (extra_token_params or {}).items()},
    }
    token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))
    access = token.get("access_token")
    if not access:
        return None

    expires_at = None
    try:
        if token.get("expires_in") is not None:
            expires_at = int(time.time()) + int(token["expires_in"])
    except Exception:
        expires_at = None

    entry = {
        "access_token": access,
        "refresh_token": token.get("refresh_token"),
        "token_type": token.get("token_type") or "Bearer",
        "scope": token.get("scope"),
        "expires_at": expires_at,
        "obtained_at": int(time.time()),
        "grant_type": "client_credentials",
    }
    set_token_entry(server_name, entry, script_file=script_file)
    return access


def oauth_maybe_refresh(server_name: str, server_cfg: dict, *, script_file: Optional[str] = None) -> Optional[str]:
    entry = get_token_entry(server_name, script_file=script_file)
    if not entry or not isinstance(entry, dict):
        return None

    if not token_is_expired(entry):
        return entry.get("access_token")

    oauth = resolve_oauth_config(server_cfg)
    if not oauth:
        return entry.get("access_token")

    # If client credentials, mint again (no refresh token needed).
    if str(oauth.get("type") or "").lower() == "client_credentials":
        minted = _mint_client_credentials_token(server_name, server_cfg, script_file=script_file)
        return minted or entry.get("access_token")

    refresh = entry.get("refresh_token")
    if not refresh:
        return entry.get("access_token")

    endpoints = resolve_oauth_endpoints(oauth)
    token_url = endpoints.get("token_url") or oauth.get("token_url")
    client_id = oauth.get("client_id")
    if not token_url or not client_id:
        return entry.get("access_token")
    _validate_secure_url(str(token_url), field="oauth.token_url", allow_http_loopback=True)

    token_req = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": str(client_id),
    }
    if oauth.get("client_secret"):
        token_req["client_secret"] = str(oauth["client_secret"])

    token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))
    access = token.get("access_token")
    if not access:
        return entry.get("access_token")

    expires_at = None
    try:
        if token.get("expires_in") is not None:
            expires_at = int(time.time()) + int(token["expires_in"])
    except Exception:
        expires_at = None

    entry["access_token"] = access
    if token.get("refresh_token"):
        entry["refresh_token"] = token.get("refresh_token")
    entry["token_type"] = token.get("token_type") or entry.get("token_type") or "Bearer"
    entry["scope"] = token.get("scope") or entry.get("scope")
    entry["expires_at"] = expires_at
    entry["obtained_at"] = int(time.time())
    set_token_entry(server_name, entry, script_file=script_file)
    return access


# =============================================================================
# Transport / Session (Client)
# =============================================================================

def detect_transport(config: dict) -> str:
    if explicit_type := config.get("type"):
        type_map = {
            "stdio": "stdio",
            "sse": "sse",
            "http": "streamable_http",
            "streamable_http": "streamable_http",
            "streamable-http": "streamable_http",
        }
        return type_map.get(str(explicit_type).lower(), str(explicit_type).lower())

    if "command" in config:
        return "stdio"

    if "url" in config:
        url = str(config["url"])
        if url.endswith("/mcp"):
            return "streamable_http"
        if url.endswith("/sse"):
            return "sse"
        return "sse"

    raise ValueError("Cannot detect transport: server config must have 'command' or 'url'.")


def build_auth_headers(
    server_name: str,
    server_cfg: dict,
    *,
    script_file: Optional[str] = None,
    force_refresh: bool = False,
) -> dict:
    headers = dict(server_cfg.get("headers") or {})

    # Explicit header always wins.
    if "Authorization" in headers:
        return headers

    if "api_key" in server_cfg:
        headers["Authorization"] = f"Bearer {server_cfg['api_key']}"
        return headers

    tok = oauth_maybe_refresh(server_name, server_cfg, script_file=script_file)
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    return headers


@asynccontextmanager
async def create_session(server_name: str, server_cfg: dict, *, script_file: Optional[str] = None):
    transport = detect_transport(server_cfg)

    try:
        from mcp import ClientSession, StdioServerParameters  # type: ignore
    except Exception:
        missing_dep("mcp")

    if transport == "stdio":
        from mcp.client.stdio import stdio_client  # type: ignore

        env = {**os.environ}
        if cfg_env := server_cfg.get("env"):
            if isinstance(cfg_env, dict):
                env.update({str(k): str(v) for k, v in cfg_env.items()})

        params = StdioServerParameters(
            command=server_cfg["command"],
            args=server_cfg.get("args", []),
            env=env,
            cwd=server_cfg.get("cwd"),
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    if transport == "sse":
        from mcp.client.sse import sse_client  # type: ignore
        url = server_cfg["url"]
        headers = build_auth_headers(server_name, server_cfg, script_file=script_file)
        timeout = server_cfg.get("timeout", 30)
        async with sse_client(url, headers=headers, timeout=timeout) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    if transport == "streamable_http":
        from mcp.client.streamable_http import streamablehttp_client  # type: ignore
        url = server_cfg["url"]
        headers = build_auth_headers(server_name, server_cfg, script_file=script_file)
        timeout = server_cfg.get("timeout", 30)
        async with streamablehttp_client(url, headers=headers, timeout=timeout) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    raise ValueError(f"Unsupported transport: {transport}")
