import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


def _have_mcp():
    try:
        import mcp  # noqa: F401

        return True
    except Exception:
        return False


@unittest.skipUnless(_have_mcp(), "python package 'mcp' not installed")
class TestMcpProxy(unittest.TestCase):
    def test_config_merge_precedence(self):
        # Load core from repo path.
        repo = Path(__file__).resolve().parents[2]
        core_dir = repo / "src" / "skills" / "mcp-common" / "scripts"
        sys.path.insert(0, str(core_dir))
        import ica_mcp_core  # type: ignore

        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            proj = td / "project"
            proj.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()

            (proj / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "a": {"command": "python", "args": ["-c", "print('a')"]},
                            "shared": {"command": "python", "args": ["-c", "print('project')"]},
                        }
                    }
                ),
                encoding="utf-8",
            )
            # ICA home file
            (ica_home / "mcp-servers.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "b": {"command": "python", "args": ["-c", "print('b')"]},
                            "shared": {"command": "python", "args": ["-c", "print('home')"]},
                        }
                    }
                ),
                encoding="utf-8",
            )

            # Pretend this is an installed ICA home.
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            old_ica_home = os.environ.get("ICA_HOME")
            os.environ["ICA_HOME"] = str(ica_home)
            try:
                loaded = ica_mcp_core.load_servers_merged(script_file=None, cwd=proj)  # type: ignore[arg-type]
            finally:
                if old_ica_home is None:
                    del os.environ["ICA_HOME"]
                else:
                    os.environ["ICA_HOME"] = old_ica_home
            self.assertIn("a", loaded.servers)
            self.assertIn("b", loaded.servers)
            # Default precedence: project overrides home.
            self.assertEqual(loaded.servers["shared"]["args"][-1], "print('project')")

            old_ica_home = os.environ.get("ICA_HOME")
            os.environ["ICA_HOME"] = str(ica_home)
            # The loader reads process env; set it for this call.
            old = os.environ.get("ICA_MCP_CONFIG_PREFER_HOME")
            os.environ["ICA_MCP_CONFIG_PREFER_HOME"] = "1"
            try:
                loaded2 = ica_mcp_core.load_servers_merged(script_file=None, cwd=proj)  # type: ignore[arg-type]
                self.assertEqual(loaded2.servers["shared"]["args"][-1], "print('home')")
            finally:
                if old is None:
                    del os.environ["ICA_MCP_CONFIG_PREFER_HOME"]
                else:
                    os.environ["ICA_MCP_CONFIG_PREFER_HOME"] = old
                if old_ica_home is None:
                    del os.environ["ICA_HOME"]
                else:
                    os.environ["ICA_HOME"] = old_ica_home

    def test_proxy_mirrors_and_calls(self):
        import anyio
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp import ClientSession

        repo = Path(__file__).resolve().parents[2]
        proxy_script = repo / "src" / "skills" / "mcp-proxy" / "scripts" / "mcp_proxy_server.py"

        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            project = td / "project"
            project.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            # Upstream FastMCP stdio server script
            upstream = td / "upstream.py"
            upstream.write_text(
                textwrap.dedent(
                    """
                    from mcp.server.fastmcp import FastMCP
                    import os

                    mcp = FastMCP("fixture")

                    @mcp.tool()
                    def echo(text: str) -> str:
                        return text

                    @mcp.tool()
                    def add(a: int, b: int) -> int:
                        return a + b

                    @mcp.tool()
                    def pid() -> int:
                        return os.getpid()

                    if __name__ == "__main__":
                        mcp.run()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            (project / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "fixture": {
                                "command": sys.executable,
                                "args": [str(upstream)],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            # Run proxy as stdio server via the MCP client.
            env = dict(os.environ)
            env["ICA_HOME"] = str(ica_home)

            params = StdioServerParameters(
                command=sys.executable,
                args=[str(proxy_script)],
                env=env,
                cwd=str(project),
            )

            async def run():
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()

                        tools = await session.list_tools()
                        names = {t.name for t in tools.tools}
                        self.assertIn("proxy.list_servers", names)
                        # Mirrored tool names
                        self.assertIn("fixture.echo", names)
                        self.assertIn("fixture.add", names)
                        self.assertIn("fixture.pid", names)

                        # Call mirrored
                        res = await session.call_tool("fixture.echo", {"text": "hi"})
                        # Content is text in most cases.
                        text = None
                        for item in res.content:
                            if hasattr(item, "text"):
                                text = item.text
                                break
                        self.assertEqual(text, "hi")

                        # Call via broker
                        res2 = await session.call_tool(
                            "proxy.call",
                            {"server": "fixture", "tool": "add", "args": {"a": 2, "b": 3}},
                        )
                        text2 = None
                        for item in res2.content:
                            if hasattr(item, "text"):
                                text2 = item.text
                                break
                        # FastMCP returns "5" as text.
                        self.assertIn("5", str(text2))

                        # Stdio pooling keeps a stable upstream process/session for repeated calls.
                        p1 = await session.call_tool("fixture.pid", {})
                        p2 = await session.call_tool("fixture.pid", {})
                        pid1 = next((item.text for item in p1.content if hasattr(item, "text")), None)
                        pid2 = next((item.text for item in p2.content if hasattr(item, "text")), None)
                        self.assertEqual(pid1, pid2)

            anyio.run(run)

    def test_proxy_concurrent_burst_on_pooled_stdio(self):
        import anyio
        from mcp import ClientSession
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client

        repo = Path(__file__).resolve().parents[2]
        proxy_script = repo / "src" / "skills" / "mcp-proxy" / "scripts" / "mcp_proxy_server.py"

        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            project = td / "project"
            project.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            upstream = td / "upstream.py"
            upstream.write_text(
                textwrap.dedent(
                    """
                    from mcp.server.fastmcp import FastMCP
                    import os
                    import time

                    mcp = FastMCP("fixture")

                    @mcp.tool()
                    def pid() -> int:
                        return os.getpid()

                    @mcp.tool()
                    def sleepy_pid(delay_ms: int = 5) -> int:
                        time.sleep(max(0, delay_ms) / 1000)
                        return os.getpid()

                    if __name__ == "__main__":
                        mcp.run()
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            (project / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "fixture": {
                                "command": sys.executable,
                                "args": [str(upstream)],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            env = dict(os.environ)
            env["ICA_HOME"] = str(ica_home)
            env["ICA_MCP_PROXY_POOL_STDIO"] = "1"
            env["ICA_MCP_PROXY_DISABLE_POOLING"] = "0"
            env["ICA_MCP_PROXY_UPSTREAM_IDLE_TTL_S"] = "120"
            env["ICA_MCP_PROXY_UPSTREAM_REQUEST_TIMEOUT_S"] = "30"

            params = StdioServerParameters(
                command=sys.executable,
                args=[str(proxy_script)],
                env=env,
                cwd=str(project),
            )

            async def run():
                import asyncio

                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        await session.list_tools()

                        async def one_call(i: int) -> str:
                            # Mix mirrored and broker calls in one burst.
                            if i % 2 == 0:
                                res = await session.call_tool("fixture.sleepy_pid", {"delay_ms": 8})
                            else:
                                res = await session.call_tool(
                                    "proxy.call",
                                    {"server": "fixture", "tool": "sleepy_pid", "args": {"delay_ms": 8}},
                                )
                            text = next((item.text for item in res.content if hasattr(item, "text")), None)
                            self.assertIsNotNone(text)
                            return str(text)

                        pids = await asyncio.gather(*[one_call(i) for i in range(40)])
                        self.assertEqual(len(pids), 40)
                        self.assertEqual(len(set(pids)), 1)

                        # Follow-up calls should stay healthy after the burst.
                        follow_up = await session.call_tool("fixture.pid", {})
                        follow_up_pid = next(
                            (item.text for item in follow_up.content if hasattr(item, "text")),
                            None,
                        )
                        self.assertIsNotNone(follow_up_pid)
                        self.assertEqual(str(follow_up_pid), pids[0])

            anyio.run(run)


if __name__ == "__main__":
    unittest.main()
