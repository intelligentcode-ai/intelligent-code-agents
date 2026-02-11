#!/usr/bin/env python3
"""
Universal MCP Client - Connect to MCP servers from simple JSON config files.

Why this exists:
- Many MCP servers have large tool schemas. This CLI enables progressive disclosure:
  list tools only when needed, for a specific server, instead of dumping schemas
  into the agent context.

Supports MCP transports:
- stdio (local subprocess servers)
- sse (remote, legacy-ish)
- streamable_http (remote, modern; /mcp)

Config resolution (priority order):
1. MCP_CONFIG_PATH env var (path to config file)
2. MCP_CONFIG env var (inline JSON)
3. .mcp.json in current directory
4. $ICA_HOME/mcp-servers.json (ICA canonical, agent-agnostic)
5. references/mcp-config.json next to this script (skill-local, optional)
6. ~/.claude.json (Claude Code compatibility; reads mcpServers)

Usage:
    python mcp_client.py servers
    python mcp_client.py tools <server>
    python mcp_client.py call <server> <tool> '{"arg": "value"}'
"""

import asyncio
import json
import os
import re
import sys
import time
import threading
import secrets
import hashlib
import base64
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler
from socketserver import TCPServer
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

# Share logic with ICA MCP tools when available.
def _import_core():
    here = Path(__file__).resolve()
    skills_dir = here.parents[2]
    common = skills_dir / "mcp-common" / "scripts"
    if common.exists():
        sys.path.insert(0, str(common))
    try:
        import ica_mcp_core  # type: ignore
        return ica_mcp_core
    except Exception:
        return None


_CORE = _import_core()


# =============================================================================
# Helpers: Output / Errors
# =============================================================================

def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, default=str))


def _print_error(message: str, error_type: str = "error") -> None:
    _print_json({"error": message, "type": error_type})


class DependencyError(RuntimeError):
    pass


def _missing_dep(dep: str, extra: str = "") -> None:
    hint = f"Missing dependency '{dep}'. Install it with: pip install {dep}"
    if extra:
        hint = f"{hint}. {extra}"
    raise DependencyError(hint)


# =============================================================================
# Config Loading
# =============================================================================

def _get_ica_home() -> Optional[Path]:
    """
    Resolve ICA_HOME in a way that works across agent runtimes.

    Priority:
    - ICA_HOME env var
    - infer from install layout: <ICA_HOME>/skills/mcp-client/scripts/mcp_client.py
    """
    if os.environ.get("ICA_HOME"):
        return Path(os.environ["ICA_HOME"]).expanduser()

    script_dir = Path(__file__).resolve().parent
    # If installed, script path looks like: <ICA_HOME>/skills/mcp-client/scripts/mcp_client.py
    try:
        if script_dir.parent.parent.name == "skills":
            return script_dir.parent.parent.parent
    except Exception:
        return None

    return None


def _find_config_file() -> Optional[Path]:
    script_dir = Path(__file__).resolve().parent
    ica_home = _get_ica_home()

    # 1) Explicit env var path
    if env_path := os.environ.get("MCP_CONFIG_PATH"):
        path = Path(env_path).expanduser()
        if path.exists():
            return path

    # 2) Project-local config
    local_config = Path(".mcp.json")
    if local_config.exists():
        return local_config

    # 3) ICA canonical location (agent-agnostic)
    if ica_home:
        for name in ("mcp-servers.json", "mcp.json"):
            p = (ica_home / name)
            if p.exists():
                return p

    # 4) Skill-local config (optional; keep secrets out of git)
    skill_config = script_dir.parent / "references" / "mcp-config.json"
    if skill_config.exists():
        return skill_config

    # 5) Claude Code compatibility
    claude_config = Path.home() / ".claude.json"
    if claude_config.exists():
        return claude_config

    return None


def _normalize_servers(config: dict) -> dict:
    # Accept {"mcpServers": {...}} or direct {...}
    servers = config.get("mcpServers", config)
    if not isinstance(servers, dict):
        raise ValueError("Config must be an object or contain an 'mcpServers' object.")

    # Filter obvious non-server keys defensively when a full settings JSON is passed.
    filtered: dict[str, Any] = {}
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        if "command" in cfg or "url" in cfg:
            filtered[name] = cfg
    return filtered


_ENV_VAR_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


def _expand_env_placeholders(value: Any) -> Any:
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
        return [_expand_env_placeholders(v) for v in value]

    if isinstance(value, dict):
        return {k: _expand_env_placeholders(v) for k, v in value.items()}

    return value


def _load_servers() -> dict:
    # Prefer shared core if present: supports merged project + ICA_HOME config.
    if _CORE is not None:
        loaded = _CORE.load_servers_merged(script_file=__file__)  # type: ignore[attr-defined]
        return loaded.servers

    # Fallback to legacy behavior (single config file).
    if env_config := os.environ.get("MCP_CONFIG"):
        try:
            cfg = json.loads(env_config)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid MCP_CONFIG JSON: {e}") from e
        return _normalize_servers(cfg)

    config_path = _find_config_file()
    if not config_path:
        raise FileNotFoundError(
            "No MCP config found. Set MCP_CONFIG_PATH or MCP_CONFIG, "
            "or create .mcp.json in the current directory."
        )

    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    servers = _normalize_servers(cfg)
    return _expand_env_placeholders(servers)


def _get_server_config(servers: dict, server_name: str) -> dict:
    if server_name not in servers:
        available = ", ".join(sorted(servers.keys())) or "(none)"
        raise ValueError(f"Server '{server_name}' not found. Available: {available}")
    return servers[server_name]


# =============================================================================
# Token Storage (OAuth)
# =============================================================================

def _tokens_path() -> Optional[Path]:
    ica_home = _get_ica_home()
    if not ica_home:
        return None
    return ica_home / "mcp-tokens.json"


def _load_tokens() -> dict:
    path = _tokens_path()
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


def _save_tokens(data: dict) -> None:
    path = _tokens_path()
    if not path:
        raise ValueError("ICA_HOME is required to store tokens (set ICA_HOME or install into an agent home).")

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        # Best-effort (Windows may ignore)
        pass


def _get_token_entry(server_name: str) -> Optional[dict]:
    data = _load_tokens()
    return data.get("servers", {}).get(server_name)


def _set_token_entry(server_name: str, entry: dict) -> None:
    data = _load_tokens()
    data.setdefault("servers", {})[server_name] = entry
    _save_tokens(data)


def _delete_token_entry(server_name: str) -> bool:
    data = _load_tokens()
    servers = data.setdefault("servers", {})
    if server_name in servers:
        del servers[server_name]
        _save_tokens(data)
        return True
    return False


def _token_is_expired(entry: dict, skew_seconds: int = 30) -> bool:
    expires_at = entry.get("expires_at")
    if not expires_at:
        return False
    try:
        return time.time() >= float(expires_at) - skew_seconds
    except Exception:
        return False


# =============================================================================
# OAuth Helpers
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


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _pkce_pair() -> tuple[str, str]:
    # RFC7636: 43-128 chars. Use urlsafe token and trim.
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _resolve_oauth_config(server_cfg: dict) -> Optional[dict]:
    oauth = server_cfg.get("oauth")
    if not oauth or not isinstance(oauth, dict):
        return None
    return oauth


def _resolve_oauth_endpoints(oauth: dict) -> dict:
    """
    Return endpoints needed for the configured oauth flow.
    Supports:
    - oidc_pkce: issuer discovery -> authorization_endpoint + token_endpoint
    - oidc_device_code: issuer discovery -> device_authorization_endpoint + token_endpoint
    - pkce: uses authorization_url + token_url
    - device_code: uses device_authorization_url + token_url
    """
    typ = str(oauth.get("type") or "pkce").lower()

    if typ.startswith("oidc"):
        issuer = oauth.get("issuer")
        if not issuer:
            raise ValueError("oauth.issuer is required for OIDC flows.")
        well_known = str(issuer).rstrip("/") + "/.well-known/openid-configuration"
        cfg = _http_json_get(well_known)
        endpoints = {
            "authorization_url": cfg.get("authorization_endpoint"),
            "token_url": cfg.get("token_endpoint"),
            "device_authorization_url": cfg.get("device_authorization_endpoint"),
        }
        return endpoints

    # Non-OIDC: explicit endpoints
    return {
        "authorization_url": oauth.get("authorization_url"),
        "token_url": oauth.get("token_url"),
        "device_authorization_url": oauth.get("device_authorization_url"),
    }


class _OAuthRedirectHandler(BaseHTTPRequestHandler):
    # Shared state injected at construction time via closure.
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
        # Silence default request logging.
        return


async def _oauth_auth_pkce(server_name: str, server_cfg: dict) -> dict:
    oauth = _resolve_oauth_config(server_cfg)
    if not oauth:
        raise ValueError("Server is missing oauth configuration.")

    endpoints = _resolve_oauth_endpoints(oauth)
    auth_url = endpoints.get("authorization_url")
    token_url = endpoints.get("token_url")
    if not auth_url or not token_url:
        raise ValueError("OAuth PKCE requires authorization_url and token_url (or OIDC issuer).")

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

    # Start local redirect listener.
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
        # Try to open a browser; if it fails, print URL in response JSON.
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass

        # Wait (blocking) for the redirect.
        if not event.wait(timeout=int(oauth.get("timeout", 300))):
            raise TimeoutError("Timed out waiting for OAuth redirect.")

        if "code" not in result:
            raise ValueError(f"OAuth redirect error: {result.get('error')} {result.get('error_description') or ''}".strip())

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
        # Some providers require client_secret even with PKCE (confidential clients).
        if oauth.get("client_secret"):
            token_req["client_secret"] = str(oauth["client_secret"])

        token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))

        access = token.get("access_token")
        if not access:
            raise ValueError("Token response missing access_token.")

        expires_in = token.get("expires_in")
        expires_at = None
        try:
            if expires_in is not None:
                expires_at = int(time.time()) + int(expires_in)
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
        _set_token_entry(server_name, entry)
        return {"status": "ok", "server": server_name, "auth_url": url, "saved_to": str(_tokens_path() or "")}
    finally:
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:
            pass


async def _oauth_auth_device_code(server_name: str, server_cfg: dict) -> dict:
    oauth = _resolve_oauth_config(server_cfg)
    if not oauth:
        raise ValueError("Server is missing oauth configuration.")

    endpoints = _resolve_oauth_endpoints(oauth)
    device_url = endpoints.get("device_authorization_url")
    token_url = endpoints.get("token_url")
    if not device_url or not token_url:
        raise ValueError("OAuth device code requires device_authorization_url and token_url (or OIDC issuer).")

    client_id = oauth.get("client_id")
    if not client_id:
        raise ValueError("oauth.client_id is required.")

    scopes = oauth.get("scopes") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    if not isinstance(scopes, list):
        raise ValueError("oauth.scopes must be a list of strings or a space-delimited string.")

    req = {
        "client_id": str(client_id),
        "scope": " ".join([str(s) for s in scopes]),
    }
    device = _http_form_post(str(device_url), req, timeout=int(oauth.get("token_timeout", 30)))
    device_code = device.get("device_code")
    user_code = device.get("user_code")
    verify_uri = device.get("verification_uri") or device.get("verification_uri_complete")
    interval = int(device.get("interval") or 5)
    expires_in = int(device.get("expires_in") or 600)

    if not device_code or not user_code or not verify_uri:
        raise ValueError("Device code response missing required fields.")

    # Tell user what to do (this is the key UX for device-code).
    started = int(time.time())
    deadline = started + expires_in
    instructions = {
        "verification_uri": device.get("verification_uri"),
        "verification_uri_complete": device.get("verification_uri_complete"),
        "user_code": user_code,
        "expires_in": expires_in,
        "interval": interval,
    }

    # Poll token endpoint.
    while int(time.time()) < deadline:
        token_req = {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": device_code,
            "client_id": str(client_id),
        }
        if oauth.get("client_secret"):
            token_req["client_secret"] = str(oauth["client_secret"])
        try:
            token = _http_form_post(str(token_url), token_req, timeout=int(oauth.get("token_timeout", 30)))
        except Exception as e:
            # Many providers return 400 with JSON error; urllib raises. Best-effort parse:
            try:
                if hasattr(e, "read"):
                    token = json.loads(e.read().decode("utf-8", errors="replace"))  # type: ignore[attr-defined]
                else:
                    raise
            except Exception:
                raise

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
            _set_token_entry(server_name, entry)
            return {"status": "ok", "server": server_name, "saved_to": str(_tokens_path() or ""), "device": instructions}

        # Typical OAuth device errors: authorization_pending, slow_down
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


def _oauth_maybe_refresh(server_name: str, server_cfg: dict) -> Optional[str]:
    """
    If we have a stored token for this server, refresh it if expired and possible.
    Returns an access token if available.
    """
    entry = _get_token_entry(server_name)
    if not entry or not isinstance(entry, dict):
        return None

    if not _token_is_expired(entry):
        return entry.get("access_token")

    refresh = entry.get("refresh_token")
    oauth = _resolve_oauth_config(server_cfg)
    if not refresh or not oauth:
        return entry.get("access_token")

    endpoints = _resolve_oauth_endpoints(oauth)
    token_url = endpoints.get("token_url") or oauth.get("token_url")
    client_id = oauth.get("client_id")
    if not token_url or not client_id:
        return entry.get("access_token")

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
    _set_token_entry(server_name, entry)
    return access


# =============================================================================
# Transport Detection & Connection
# =============================================================================

def _detect_transport(config: dict) -> str:
    # Explicit type takes precedence
    if explicit_type := config.get("type"):
        type_map = {
            "stdio": "stdio",
            "sse": "sse",
            "http": "streamable_http",
            "streamable_http": "streamable_http",
            "streamable-http": "streamable_http",
        }
        return type_map.get(str(explicit_type).lower(), str(explicit_type).lower())

    # Infer from config keys
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


@asynccontextmanager
async def _create_session(config: dict):
    transport = _detect_transport(config)

    # mcp SDK is required for stdio/sse/streamable_http
    try:
        from mcp import ClientSession, StdioServerParameters  # type: ignore
    except Exception:
        _missing_dep("mcp")

    if transport == "stdio":
        from mcp.client.stdio import stdio_client  # type: ignore

        env = {**os.environ}
        if config_env := config.get("env"):
            if isinstance(config_env, dict):
                env.update({str(k): str(v) for k, v in config_env.items()})

        server_params = StdioServerParameters(
            command=config["command"],
            args=config.get("args", []),
            env=env,
            cwd=config.get("cwd"),
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    if transport == "sse":
        from mcp.client.sse import sse_client  # type: ignore

        url = config["url"]
        headers = dict(config.get("headers") or {})
        # Prefer explicit headers, then api_key sugar, then stored OAuth token.
        if "api_key" in config and "Authorization" not in headers:
            headers["Authorization"] = f"Bearer {config['api_key']}"
        if "Authorization" not in headers and config.get("__server_name"):
            tok = _oauth_maybe_refresh(str(config["__server_name"]), config)
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
        timeout = config.get("timeout", 30)

        async with sse_client(url, headers=headers, timeout=timeout) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    if transport == "streamable_http":
        from mcp.client.streamable_http import streamablehttp_client  # type: ignore

        url = config["url"]
        headers = dict(config.get("headers") or {})
        if "api_key" in config and "Authorization" not in headers:
            headers["Authorization"] = f"Bearer {config['api_key']}"
        if "Authorization" not in headers and config.get("__server_name"):
            tok = _oauth_maybe_refresh(str(config["__server_name"]), config)
            if tok:
                headers["Authorization"] = f"Bearer {tok}"
        timeout = config.get("timeout", 30)

        async with streamablehttp_client(url, headers=headers, timeout=timeout) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    raise ValueError(f"Unsupported transport: {transport}")


# =============================================================================
# Commands
# =============================================================================

def _cmd_servers(servers: dict) -> list[dict]:
    result: list[dict] = []
    for name, config in servers.items():
        try:
            transport = _detect_transport(config)
        except Exception as e:
            result.append({"name": name, "error": str(e)})
            continue

        info: dict[str, Any] = {"name": name, "transport": transport}
        if transport == "stdio":
            info["command"] = config.get("command")
        else:
            info["url"] = config.get("url")
        result.append(info)
    return result


async def _cmd_tools(servers: dict, server_name: str) -> list[dict]:
    config = dict(_get_server_config(servers, server_name))
    config["__server_name"] = server_name
    async with _create_session(config) as session:
        result = await session.list_tools()
        tools: list[dict] = []
        for tool in result.tools:
            tools.append(
                {
                    "name": tool.name,
                    "description": getattr(tool, "description", None),
                    "parameters": getattr(tool, "inputSchema", None),
                }
            )
        return tools


async def _cmd_call(servers: dict, server_name: str, tool_name: str, arguments: dict) -> Any:
    config = dict(_get_server_config(servers, server_name))
    config["__server_name"] = server_name
    async with _create_session(config) as session:
        result = await session.call_tool(tool_name, arguments)

        # Extract content from result when possible (mcp SDK style).
        if hasattr(result, "content"):
            contents = []
            for item in result.content:
                if hasattr(item, "text"):
                    contents.append(item.text)
                elif hasattr(item, "data"):
                    contents.append({"type": "data", "data": item.data})
                else:
                    contents.append(str(item))
            return contents[0] if len(contents) == 1 else contents
        return result


# =============================================================================
# CLI Interface
# =============================================================================

def _print_usage() -> None:
    usage = """Usage: mcp_client.py <command> [args]

Commands:
  servers
  tools <server>
  call <server> <tool> '<json>'
  auth <server>
  token <server>
  logout <server>

Examples:
  python mcp_client.py servers
  python mcp_client.py tools sequential-thinking
  python mcp_client.py call github search_repos '{"query":"python mcp"}'
  python mcp_client.py auth some-remote-oauth-server

Config sources (checked in order):
  1. MCP_CONFIG_PATH (path to JSON)
  2. MCP_CONFIG (inline JSON)
  3. .mcp.json (current directory)
  4. $ICA_HOME/mcp-servers.json (or $ICA_HOME/mcp.json)
  5. references/mcp-config.json (next to this script)
  6. ~/.claude.json"""
    print(usage)


async def main() -> None:
    if len(sys.argv) < 2:
        _print_usage()
        raise SystemExit(1)

    command = sys.argv[1].lower()
    if command in ("--help", "-h", "help"):
        _print_usage()
        return

    try:
        servers = _load_servers()
    except (FileNotFoundError, ValueError) as e:
        _print_error(str(e), "configuration")
        raise SystemExit(1)

    try:
        if command == "servers":
            _print_json(_cmd_servers(servers))
            return

        if command == "tools":
            if len(sys.argv) < 3:
                _print_error("Usage: tools <server_name>", "usage")
                raise SystemExit(1)
            _print_json(await _cmd_tools(servers, sys.argv[2]))
            return

        if command == "call":
            if len(sys.argv) < 4:
                _print_error("Usage: call <server> <tool> [json_args]", "usage")
                raise SystemExit(1)
            args: dict[str, Any] = {}
            if len(sys.argv) >= 5:
                try:
                    args = json.loads(sys.argv[4])
                except json.JSONDecodeError as e:
                    _print_error(f"Invalid JSON arguments: {e}", "invalid_args")
                    raise SystemExit(1)
            _print_json(await _cmd_call(servers, sys.argv[2], sys.argv[3], args))
            return

        if command == "auth":
            if len(sys.argv) < 3:
                _print_error("Usage: auth <server>", "usage")
                raise SystemExit(1)
            server_name = sys.argv[2]
            cfg = _get_server_config(servers, server_name)
            oauth = _resolve_oauth_config(cfg)
            if not oauth:
                _print_error("Server has no oauth configuration.", "configuration")
                raise SystemExit(1)
            typ = str(oauth.get("type") or "pkce").lower()
            if "device" in typ:
                _print_json(await _oauth_auth_device_code(server_name, cfg))
                return
            res = await _oauth_auth_pkce(server_name, cfg)
            _print_json(res)
            return

        if command == "token":
            if len(sys.argv) < 3:
                _print_error("Usage: token <server>", "usage")
                raise SystemExit(1)
            server_name = sys.argv[2]
            entry = _get_token_entry(server_name)
            if not entry:
                _print_json({"server": server_name, "status": "missing"})
                return
            _print_json(
                {
                    "server": server_name,
                    "status": "present",
                    "expires_at": entry.get("expires_at"),
                    "expired": _token_is_expired(entry),
                    "scope": entry.get("scope"),
                    "token_type": entry.get("token_type"),
                }
            )
            return

        if command == "logout":
            if len(sys.argv) < 3:
                _print_error("Usage: logout <server>", "usage")
                raise SystemExit(1)
            server_name = sys.argv[2]
            ok = _delete_token_entry(server_name)
            _print_json({"server": server_name, "status": "deleted" if ok else "missing"})
            return

        _print_error(f"Unknown command: {command}", "usage")
        _print_usage()
        raise SystemExit(1)

    except ValueError as e:
        _print_error(str(e), "validation")
        raise SystemExit(1)
    except DependencyError as e:
        _print_error(str(e), "dependency")
        raise SystemExit(1)
    except Exception as e:
        _print_error(str(e), "error")
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
