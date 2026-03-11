#!/usr/bin/env python3
"""
ICA MCP Proxy Server (stdio)

Implements a local MCP server that:
- loads upstream MCP servers from .mcp.json and/or $ICA_HOME/mcp-servers.json
- mirrors upstream tools as proxy tools: "<server>.<tool>"
- provides stable broker tools under "proxy.*"
- manages OAuth + token caching in $ICA_HOME/mcp-tokens.json
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


def _import_core():
    # Resolve bundled fallback first, then shared mcp-common for installed setups.
    here = Path(__file__).resolve()
    skills_dir = here.parents[2]  # .../skills
    bundled = here.parent / "_internal"
    common = skills_dir / "mcp-common" / "scripts"
    import sys

    for candidate in (bundled, common):
        if candidate.exists():
            resolved = str(candidate)
            if resolved not in sys.path:
                sys.path.append(resolved)
    try:
        from ica_mcp_core import (  # type: ignore
            DependencyError,
            create_session,
            delete_token_entry,
            detect_transport,
            get_token_entry,
            load_servers_merged,
            oauth_auth_client_credentials,
            oauth_auth_device_code,
            oauth_auth_pkce,
            oauth_maybe_refresh,
            resolve_oauth_config,
            set_token_entry,
            token_is_expired,
            tokens_path,
        )

        return {
            "DependencyError": DependencyError,
            "create_session": create_session,
            "delete_token_entry": delete_token_entry,
            "detect_transport": detect_transport,
            "get_token_entry": get_token_entry,
            "load_servers_merged": load_servers_merged,
            "oauth_auth_client_credentials": oauth_auth_client_credentials,
            "oauth_auth_device_code": oauth_auth_device_code,
            "oauth_auth_pkce": oauth_auth_pkce,
            "oauth_maybe_refresh": oauth_maybe_refresh,
            "resolve_oauth_config": resolve_oauth_config,
            "set_token_entry": set_token_entry,
            "token_is_expired": token_is_expired,
            "tokens_path": tokens_path,
        }
    except Exception as e:
        raise RuntimeError(
            "Failed to import ICA MCP core. "
            "Expected either bundled fallback at '_internal/ica_mcp_core.py' "
            "or shared 'mcp-common/scripts/ica_mcp_core.py'."
        ) from e


core = _import_core()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


_NAME_OK = re.compile(r"^[A-Za-z0-9_.-]+$")


def _sanitize(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", s)


def _schema_size(schema: Any) -> int:
    try:
        return len(json.dumps(schema, separators=(",", ":"), default=str).encode("utf-8"))
    except Exception:
        return 0


def _config_fingerprint(cfg: dict[str, Any]) -> str:
    try:
        raw = json.dumps(cfg, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    except Exception:
        raw = repr(cfg).encode("utf-8", errors="replace")
    return hashlib.sha1(raw).hexdigest()


@dataclass
class MirrorStatus:
    sources: list[str]
    servers_total: int
    servers_mirrored: int
    tools_total: int
    tools_mirrored: int
    truncated: bool
    reasons: list[str]
    blocked_servers: dict[str, str]


@dataclass
class _WorkerRequest:
    op: str
    tool_name: Optional[str] = None
    args: Optional[dict[str, Any]] = None
    future: Optional[asyncio.Future] = None


class UpstreamWorker:
    """
    Owns one upstream stdio MCP session in a dedicated task.

    This avoids AnyIO cancel-scope lifecycle mismatches by ensuring session
    enter/use/exit all happen in the same task.
    """

    def __init__(
        self,
        *,
        server_name: str,
        server_cfg: dict[str, Any],
        idle_ttl_s: float,
        request_timeout_s: float,
        script_file: str,
    ):
        self.server_name = server_name
        self.server_cfg = server_cfg
        self.config_fingerprint = _config_fingerprint(server_cfg)
        self.idle_ttl_s = idle_ttl_s
        self.request_timeout_s = request_timeout_s
        self.script_file = script_file

        self._queue: asyncio.Queue[_WorkerRequest] = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._start_lock = asyncio.Lock()

    async def ensure_started(self) -> None:
        if self._task and not self._task.done():
            return
        async with self._start_lock:
            if self._task and not self._task.done():
                return
            self._task = asyncio.create_task(
                self._run(),
                name=f"ica-mcp-worker:{self.server_name}",
            )

    async def list_tools(self) -> Any:
        return await self._request("list_tools")

    async def call_tool(self, tool_name: str, args: dict[str, Any]) -> Any:
        return await self._request("call_tool", tool_name=tool_name, args=args)

    async def _request(
        self,
        op: str,
        *,
        tool_name: Optional[str] = None,
        args: Optional[dict[str, Any]] = None,
    ) -> Any:
        await self.ensure_started()
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        await self._queue.put(_WorkerRequest(op=op, tool_name=tool_name, args=args, future=fut))
        if self.request_timeout_s > 0:
            return await asyncio.wait_for(fut, timeout=self.request_timeout_s)
        return await fut

    async def shutdown(self) -> None:
        task = self._task
        if not task:
            return

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        try:
            await self._queue.put(_WorkerRequest(op="shutdown", future=fut))
            try:
                await asyncio.wait_for(fut, timeout=5)
            except Exception:
                pass
            try:
                await asyncio.wait_for(task, timeout=5)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(Exception):
                    await task
        finally:
            self._task = None

    async def _run(self) -> None:
        stack = AsyncExitStack()
        session: Any = None
        try:
            while True:
                try:
                    if self.idle_ttl_s > 0:
                        req = await asyncio.wait_for(self._queue.get(), timeout=self.idle_ttl_s)
                    else:
                        req = await self._queue.get()
                except asyncio.TimeoutError:
                    # Idle timeout: recycle upstream session to release resources.
                    if session is not None:
                        with contextlib.suppress(Exception):
                            await stack.aclose()
                        stack = AsyncExitStack()
                        session = None
                    continue

                if req.op == "shutdown":
                    if req.future and not req.future.done():
                        req.future.set_result({"status": "ok"})
                    break

                try:
                    if session is None:
                        ctx = core["create_session"](
                            self.server_name, self.server_cfg, script_file=self.script_file
                        )
                        session = await stack.enter_async_context(ctx)

                    if req.op == "list_tools":
                        result = await session.list_tools()
                    elif req.op == "call_tool":
                        result = await session.call_tool(req.tool_name, req.args or {})
                    else:
                        raise ValueError(f"Unknown worker operation: {req.op}")

                    if req.future and not req.future.done():
                        req.future.set_result(result)
                except Exception as exc:
                    # Reset session on failures to avoid stale/broken state.
                    with contextlib.suppress(Exception):
                        await stack.aclose()
                    stack = AsyncExitStack()
                    session = None
                    if req.future and not req.future.done():
                        req.future.set_exception(exc)
        finally:
            with contextlib.suppress(Exception):
                await stack.aclose()


class ProxyRuntime:
    def __init__(self):
        self._tools_cache_ttl_s = _env_float("ICA_MCP_PROXY_TOOL_CACHE_TTL_S", 300)
        self._max_servers = _env_int("ICA_MCP_PROXY_MAX_SERVERS", 25)
        self._max_tools_per_server = _env_int("ICA_MCP_PROXY_MAX_TOOLS_PER_SERVER", 200)
        self._max_total_tools = _env_int("ICA_MCP_PROXY_MAX_TOTAL_TOOLS", 2000)
        self._max_schema_bytes = _env_int("ICA_MCP_PROXY_MAX_SCHEMA_BYTES", 65536)
        self._pool_stdio = _env_bool("ICA_MCP_PROXY_POOL_STDIO", True)
        self._disable_pooling = _env_bool("ICA_MCP_PROXY_DISABLE_POOLING", False)
        self._upstream_idle_ttl_s = _env_float("ICA_MCP_PROXY_UPSTREAM_IDLE_TTL_S", 90)
        self._upstream_request_timeout_s = _env_float("ICA_MCP_PROXY_UPSTREAM_REQUEST_TIMEOUT_S", 120)

        self._servers_loaded_at: float = 0
        self._servers: dict[str, dict[str, Any]] = {}
        self._sources: list[str] = []
        self._blocked_servers: dict[str, str] = {}

        self._tools_loaded_at: dict[str, float] = {}
        self._tools_cache: dict[str, list[Any]] = {}
        self._mirror_map: dict[str, tuple[str, str]] = {}
        self._last_status: Optional[MirrorStatus] = None

        self._locks: dict[str, asyncio.Lock] = {}
        self._workers: dict[str, UpstreamWorker] = {}
        self._workers_lock = asyncio.Lock()

    def _lock_for(self, server: str) -> asyncio.Lock:
        if server not in self._locks:
            self._locks[server] = asyncio.Lock()
        return self._locks[server]

    def _load_servers(self) -> tuple[dict[str, dict[str, Any]], list[str]]:
        loaded = core["load_servers_merged"](script_file=__file__)
        servers = dict(loaded.servers)
        sources = list(loaded.sources)
        self._blocked_servers = dict(getattr(loaded, "blocked_servers", {}) or {})

        # Reserve "proxy" namespace.
        if "proxy" in servers:
            servers.pop("proxy", None)
        return servers, sources

    async def get_servers(self) -> tuple[dict[str, dict[str, Any]], list[str]]:
        # Light caching; config reads are cheap but avoid hammering.
        if time.time() - self._servers_loaded_at > 2:
            self._servers, self._sources = self._load_servers()
            self._servers_loaded_at = time.time()
            await self._prune_workers(valid_servers=set(self._servers.keys()))
        return self._servers, self._sources

    def _should_pool(self, cfg: dict[str, Any]) -> bool:
        if self._disable_pooling or not self._pool_stdio:
            return False
        try:
            return core["detect_transport"](cfg) == "stdio"
        except Exception:
            return False

    async def _get_worker(self, server_name: str, cfg: dict[str, Any]) -> UpstreamWorker:
        cfg_fp = _config_fingerprint(cfg)
        replaced: Optional[UpstreamWorker] = None
        async with self._workers_lock:
            existing = self._workers.get(server_name)
            if existing and existing.config_fingerprint != cfg_fp:
                replaced = existing
                self._workers.pop(server_name, None)

            worker = self._workers.get(server_name)
            if worker is None:
                worker = UpstreamWorker(
                    server_name=server_name,
                    server_cfg=cfg,
                    idle_ttl_s=self._upstream_idle_ttl_s,
                    request_timeout_s=self._upstream_request_timeout_s,
                    script_file=__file__,
                )
                self._workers[server_name] = worker

        if replaced is not None:
            await replaced.shutdown()
        await worker.ensure_started()
        return worker

    async def _prune_workers(self, valid_servers: set[str]) -> None:
        stale: list[UpstreamWorker] = []
        async with self._workers_lock:
            for name in list(self._workers.keys()):
                if name not in valid_servers:
                    stale.append(self._workers.pop(name))
        for worker in stale:
            await worker.shutdown()

    async def invalidate_worker(self, server_name: str) -> None:
        worker: Optional[UpstreamWorker] = None
        async with self._workers_lock:
            worker = self._workers.pop(server_name, None)
        if worker:
            await worker.shutdown()

    async def shutdown(self) -> None:
        async with self._workers_lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for worker in workers:
            await worker.shutdown()

    async def list_upstream_tools(self, server_name: str) -> list[Any]:
        servers, _ = await self.get_servers()
        if server_name not in servers:
            raise ValueError(f"Unknown upstream server: {server_name}")

        # Cache per server
        last = self._tools_loaded_at.get(server_name, 0)
        if time.time() - last < self._tools_cache_ttl_s and server_name in self._tools_cache:
            return self._tools_cache[server_name]

        async with self._lock_for(server_name):
            # Re-check inside lock
            last = self._tools_loaded_at.get(server_name, 0)
            if time.time() - last < self._tools_cache_ttl_s and server_name in self._tools_cache:
                return self._tools_cache[server_name]

            cfg = servers[server_name]
            if self._should_pool(cfg):
                worker = await self._get_worker(server_name, cfg)
                res = await worker.list_tools()
            else:
                async with core["create_session"](server_name, cfg, script_file=__file__) as session:
                    res = await session.list_tools()
            tools = list(res.tools or [])
            self._tools_cache[server_name] = tools
            self._tools_loaded_at[server_name] = time.time()
            return tools

    async def call_upstream(self, server_name: str, tool_name: str, args: dict) -> Any:
        servers, _ = await self.get_servers()
        if server_name not in servers:
            raise ValueError(f"Unknown upstream server: {server_name}")

        cfg = servers[server_name]
        if self._should_pool(cfg):
            worker = await self._get_worker(server_name, cfg)
            return await worker.call_tool(tool_name, args)

        async with self._lock_for(server_name):
            async with core["create_session"](server_name, cfg, script_file=__file__) as session:
                return await session.call_tool(tool_name, args)

    async def build_tool_list(self):
        import mcp.types as types

        servers, sources = await self.get_servers()

        reasons: list[str] = []
        truncated = False

        broker_tools: list[types.Tool] = _broker_tool_defs()

        server_names = sorted(servers.keys())
        servers_total = len(server_names)
        if servers_total > self._max_servers:
            truncated = True
            reasons.append(f"Too many servers ({servers_total}) > ICA_MCP_PROXY_MAX_SERVERS ({self._max_servers}).")
            server_names = server_names[: self._max_servers]

        mirrored: list[types.Tool] = []
        mirror_map: dict[str, tuple[str, str]] = {}

        total_tools_seen = 0
        total_tools_mirrored = 0

        for s in server_names:
            upstream_tools = await self.list_upstream_tools(s)
            total_tools_seen += len(upstream_tools)

            tools_for_server = list(upstream_tools)[: self._max_tools_per_server]
            if len(upstream_tools) > self._max_tools_per_server:
                truncated = True
                reasons.append(
                    f"Server '{s}' tools truncated ({len(upstream_tools)}) > ICA_MCP_PROXY_MAX_TOOLS_PER_SERVER ({self._max_tools_per_server})."
                )

            for t in tools_for_server:
                if total_tools_mirrored >= self._max_total_tools:
                    truncated = True
                    reasons.append(
                        f"Total tools truncated at ICA_MCP_PROXY_MAX_TOTAL_TOOLS ({self._max_total_tools})."
                    )
                    break

                upstream_tool_name = t.name
                proxy_tool_name = f"{_sanitize(s)}.{_sanitize(upstream_tool_name)}"

                # Ensure tool name is protocol-safe.
                if not _NAME_OK.match(proxy_tool_name):
                    proxy_tool_name = _sanitize(proxy_tool_name)

                # Collision handling
                if proxy_tool_name in mirror_map:
                    # stable-ish suffix
                    suffix = hashlib.sha1(f"{s}:{upstream_tool_name}".encode("utf-8")).hexdigest()[:6]
                    proxy_tool_name = f"{proxy_tool_name}__{suffix}"

                input_schema = getattr(t, "inputSchema", None) or {"type": "object", "additionalProperties": True}
                output_schema = getattr(t, "outputSchema", None)

                schema_bytes = _schema_size(input_schema)
                meta = {"ica_proxy": {"upstream_server": s, "upstream_tool": upstream_tool_name}}

                if schema_bytes > self._max_schema_bytes:
                    truncated = True
                    reasons.append(
                        f"Tool schema truncated for '{proxy_tool_name}' ({schema_bytes} bytes) > ICA_MCP_PROXY_MAX_SCHEMA_BYTES ({self._max_schema_bytes})."
                    )
                    meta["ica_proxy"]["schema_truncated"] = True
                    meta["ica_proxy"]["original_schema_bytes"] = schema_bytes
                    input_schema = {"type": "object", "additionalProperties": True}

                mirrored.append(
                    types.Tool(
                        name=proxy_tool_name,
                        description=(getattr(t, "description", None) or "")[:4000] or None,
                        inputSchema=input_schema,
                        outputSchema=output_schema,
                        _meta=meta,
                    )
                )
                mirror_map[proxy_tool_name] = (s, upstream_tool_name)
                total_tools_mirrored += 1

            if total_tools_mirrored >= self._max_total_tools:
                break

        status = MirrorStatus(
            sources=sources,
            servers_total=servers_total,
            servers_mirrored=len(server_names),
            tools_total=total_tools_seen,
            tools_mirrored=total_tools_mirrored,
            truncated=truncated,
            reasons=reasons,
            blocked_servers=dict(self._blocked_servers),
        )
        self._mirror_map = mirror_map
        self._last_status = status

        # Always include mirror_status.
        return broker_tools + mirrored

    def resolve_mirror(self, proxy_tool_name: str) -> Optional[tuple[str, str]]:
        if proxy_tool_name in self._mirror_map:
            return self._mirror_map[proxy_tool_name]

        # Fallback parse: "<server>.<tool...>"
        if "." in proxy_tool_name:
            server, tool = proxy_tool_name.split(".", 1)
            return (server, tool)
        return None

    def mirror_status(self) -> dict:
        s = self._last_status
        if not s:
            return {"status": "unknown", "note": "No mirror status yet. Call list_tools first."}
        return {
            "sources": s.sources,
            "servers_total": s.servers_total,
            "servers_mirrored": s.servers_mirrored,
            "tools_total": s.tools_total,
            "tools_mirrored": s.tools_mirrored,
            "truncated": s.truncated,
            "reasons": s.reasons,
            "blocked_servers": s.blocked_servers,
        }



def _broker_tool_defs():
    import mcp.types as types

    # Minimal schemas for broker tools.
    obj = {"type": "object", "properties": {}}

    return [
        types.Tool(
            name="proxy.list_servers",
            description="List configured upstream MCP servers (merged from .mcp.json and $ICA_HOME/mcp-servers.json).",
            inputSchema=obj,
        ),
        types.Tool(
            name="proxy.list_tools",
            description="List tools from one upstream server. Args: {server, include_schema?}.",
            inputSchema={
                "type": "object",
                "properties": {
                    "server": {"type": "string"},
                    "include_schema": {"type": "boolean", "default": True},
                },
                "required": ["server"],
                "additionalProperties": False,
            },
        ),
        types.Tool(
            name="proxy.call",
            description="Call an upstream tool. Args: {server, tool, args}.",
            inputSchema={
                "type": "object",
                "properties": {
                    "server": {"type": "string"},
                    "tool": {"type": "string"},
                    "args": {"type": "object", "additionalProperties": True, "default": {}},
                },
                "required": ["server", "tool"],
                "additionalProperties": False,
            },
        ),
        types.Tool(
            name="proxy.mirror_status",
            description="Show mirroring/truncation status and config sources.",
            inputSchema=obj,
        ),
        types.Tool(
            name="proxy.auth_start",
            description="Start authentication for an upstream server. Args: {server, flow?}.",
            inputSchema={
                "type": "object",
                "properties": {
                    "server": {"type": "string"},
                    "flow": {"type": "string"},
                },
                "required": ["server"],
                "additionalProperties": False,
            },
        ),
        types.Tool(
            name="proxy.auth_status",
            description="Show cached token status for an upstream server. Args: {server}.",
            inputSchema={"type": "object", "properties": {"server": {"type": "string"}}, "required": ["server"]},
        ),
        types.Tool(
            name="proxy.auth_refresh",
            description="Force refresh/re-mint credentials for an upstream server. Args: {server}.",
            inputSchema={"type": "object", "properties": {"server": {"type": "string"}}, "required": ["server"]},
        ),
        types.Tool(
            name="proxy.auth_logout",
            description="Delete cached credentials for an upstream server. Args: {server}.",
            inputSchema={"type": "object", "properties": {"server": {"type": "string"}}, "required": ["server"]},
        ),
    ]


async def _handle_proxy_tool(rt: ProxyRuntime, tool_name: str, args: dict) -> Any:
    servers, sources = await rt.get_servers()

    if tool_name == "proxy.list_servers":
        return {"servers": sorted(servers.keys()), "sources": sources, "blocked_servers": dict(rt._blocked_servers)}

    if tool_name == "proxy.mirror_status":
        return rt.mirror_status()

    if tool_name == "proxy.list_tools":
        s = args.get("server")
        include_schema = bool(args.get("include_schema", True))
        tools = await rt.list_upstream_tools(str(s))
        out = []
        for t in tools:
            out.append(
                {
                    "name": t.name,
                    "description": getattr(t, "description", None),
                    "inputSchema": getattr(t, "inputSchema", None) if include_schema else None,
                    "outputSchema": getattr(t, "outputSchema", None) if include_schema else None,
                }
            )
        return {"server": str(s), "tools": out}

    if tool_name == "proxy.call":
        s = str(args.get("server"))
        tn = str(args.get("tool"))
        call_args = args.get("args") or {}
        if not isinstance(call_args, dict):
            raise ValueError("proxy.call args must be an object")
        return await rt.call_upstream(s, tn, call_args)

    if tool_name in ("proxy.auth_start", "proxy.auth_status", "proxy.auth_refresh", "proxy.auth_logout"):
        server = str(args.get("server"))
        if server not in servers:
            raise ValueError(f"Unknown upstream server: {server}")
        cfg = servers[server]

        if tool_name == "proxy.auth_status":
            entry = core["get_token_entry"](server, script_file=__file__)
            if not entry:
                return {"server": server, "status": "missing"}
            return {
                "server": server,
                "status": "present",
                "expires_at": entry.get("expires_at"),
                "expired": core["token_is_expired"](entry),
                "scope": entry.get("scope"),
                "token_type": entry.get("token_type"),
                "saved_to": str(core["tokens_path"](script_file=__file__) or ""),
            }

        if tool_name == "proxy.auth_logout":
            ok = core["delete_token_entry"](server, script_file=__file__)
            await rt.invalidate_worker(server)
            return {"server": server, "status": "deleted" if ok else "missing"}

        oauth = core["resolve_oauth_config"](cfg)
        if not oauth:
            raise ValueError("Server has no oauth configuration.")
        flow = (args.get("flow") or oauth.get("type") or "pkce").lower()

        if tool_name == "proxy.auth_refresh":
            # Force refresh: if client credentials, re-mint; else refresh token path.
            if flow == "client_credentials":
                out = await core["oauth_auth_client_credentials"](server, cfg, script_file=__file__)
                await rt.invalidate_worker(server)
                return out
            tok = core["oauth_maybe_refresh"](server, cfg, script_file=__file__)
            await rt.invalidate_worker(server)
            return {"server": server, "status": "ok" if tok else "missing"}

        # auth_start
        if flow in ("device_code", "oidc_device_code"):
            out = await core["oauth_auth_device_code"](server, cfg, script_file=__file__)
            await rt.invalidate_worker(server)
            return out
        if flow == "client_credentials":
            out = await core["oauth_auth_client_credentials"](server, cfg, script_file=__file__)
            await rt.invalidate_worker(server)
            return out
        # default pkce
        out = await core["oauth_auth_pkce"](server, cfg, script_file=__file__)
        await rt.invalidate_worker(server)
        return out

    raise ValueError(f"Unknown proxy tool: {tool_name}")


async def _run():
    try:
        import anyio
        import mcp.types as types
        from mcp.server.lowlevel import Server
        from mcp.server.models import InitializationOptions
        from mcp.server.stdio import stdio_server
    except Exception as e:
        raise RuntimeError(
            "Missing MCP server dependencies. Install: pip install mcp anyio jsonschema"
        ) from e

    rt = ProxyRuntime()

    server = Server("ica-mcp-proxy")

    @server.list_tools()
    async def _list_tools():
        return await rt.build_tool_list()

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict):
        if name.startswith("proxy."):
            res = await _handle_proxy_tool(rt, name, arguments or {})
            return res

        resolved = rt.resolve_mirror(name)
        if not resolved:
            raise ValueError(f"Unknown tool: {name}")
        upstream_server, upstream_tool = resolved
        # If upstream_server was sanitized in tool name, try best-effort match.
        # Prefer exact match; else match by sanitized name.
        servers, _ = await rt.get_servers()
        if upstream_server not in servers:
            candidates = {_sanitize(k): k for k in servers.keys()}
            if upstream_server in candidates:
                upstream_server = candidates[upstream_server]
        return await rt.call_upstream(upstream_server, upstream_tool, arguments or {})

    capabilities = types.ServerCapabilities(tools=types.ToolsCapability(listChanged=False))
    init = InitializationOptions(
        server_name="ica-mcp-proxy",
        server_version=os.environ.get("ICA_VERSION", "dev"),
        capabilities=capabilities,
        instructions="ICA MCP proxy: use proxy.* broker tools or call mirrored tools as <server>.<tool>.",
    )

    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, init)
    finally:
        await rt.shutdown()


def main():
    asyncio.run(_run())


if __name__ == "__main__":
    main()
