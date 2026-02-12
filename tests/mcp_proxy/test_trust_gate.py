import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


def _load_core():
    repo = Path(__file__).resolve().parents[2]
    candidates = [
        repo / "src" / "skills" / "mcp-common" / "scripts",
        repo.parent / "skills" / "skills" / "mcp-common" / "scripts",
    ]
    core_dir = next((candidate for candidate in candidates if candidate.exists()), None)
    if core_dir is None:
        raise ModuleNotFoundError("Unable to locate ica_mcp_core.py in local or split skills repository.")
    sys.path.insert(0, str(core_dir))
    import ica_mcp_core  # type: ignore

    return ica_mcp_core


class _EnvGuard:
    def __init__(self, updates: dict[str, str | None]):
        self._updates = updates
        self._old: dict[str, str | None] = {}

    def __enter__(self):
        for k, v in self._updates.items():
            self._old[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def __exit__(self, exc_type, exc, tb):
        for k, old in self._old.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


class TestTrustGate(unittest.TestCase):
    def test_strict_blocks_project_stdio_until_trusted(self):
        core = _load_core()
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            project = td / "project"
            project.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            (project / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "project-stdio": {"command": "python3", "args": ["-c", "print('ok')"]},
                            "project-http": {"url": "https://example.com/mcp"},
                        }
                    }
                ),
                encoding="utf-8",
            )
            (ica_home / "mcp-servers.json").write_text(
                json.dumps({"mcpServers": {"home-stdio": {"command": "python3", "args": ["-c", "print('ok')"]}}}),
                encoding="utf-8",
            )

            with _EnvGuard(
                {
                    "ICA_HOME": str(ica_home),
                    "ICA_MCP_STRICT_TRUST": "1",
                    "ICA_MCP_ALLOW_PROJECT_STDIO": None,
                    "MCP_CONFIG": None,
                    "MCP_CONFIG_PATH": None,
                }
            ):
                loaded = core.load_servers_merged(script_file=None, cwd=project)
                self.assertNotIn("project-stdio", loaded.servers)
                self.assertIn("project-http", loaded.servers)
                self.assertIn("home-stdio", loaded.servers)
                self.assertIn("project-stdio", loaded.blocked_servers)

                trust = core.trust_project(project, script_file=None)
                self.assertTrue(trust["trusted"])

                loaded2 = core.load_servers_merged(script_file=None, cwd=project)
                self.assertIn("project-stdio", loaded2.servers)
                self.assertEqual(loaded2.blocked_servers, {})

    def test_strict_allows_temporary_env_override(self):
        core = _load_core()
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            project = td / "project"
            project.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            (project / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"project-stdio": {"command": "python3", "args": ["-c", "print('ok')"]}}}),
                encoding="utf-8",
            )

            with _EnvGuard(
                {
                    "ICA_HOME": str(ica_home),
                    "ICA_MCP_STRICT_TRUST": "1",
                    "ICA_MCP_ALLOW_PROJECT_STDIO": "1",
                    "MCP_CONFIG": None,
                    "MCP_CONFIG_PATH": None,
                }
            ):
                loaded = core.load_servers_merged(script_file=None, cwd=project)
                self.assertIn("project-stdio", loaded.servers)
                self.assertEqual(loaded.blocked_servers, {})

    def test_strict_requires_retrust_after_project_config_change(self):
        core = _load_core()
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            project = td / "project"
            project.mkdir()
            ica_home = td / "ica-home"
            ica_home.mkdir()
            (ica_home / "VERSION").write_text("test", encoding="utf-8")

            mcp_path = project / ".mcp.json"
            mcp_path.write_text(
                json.dumps({"mcpServers": {"project-stdio": {"command": "python3", "args": ["-c", "print('ok')"]}}}),
                encoding="utf-8",
            )

            with _EnvGuard(
                {
                    "ICA_HOME": str(ica_home),
                    "ICA_MCP_STRICT_TRUST": "1",
                    "ICA_MCP_ALLOW_PROJECT_STDIO": None,
                    "MCP_CONFIG": None,
                    "MCP_CONFIG_PATH": None,
                }
            ):
                core.trust_project(project, script_file=None)
                loaded = core.load_servers_merged(script_file=None, cwd=project)
                self.assertIn("project-stdio", loaded.servers)

                # Modify config; trust hash should invalidate.
                mcp_path.write_text(
                    json.dumps(
                        {
                            "mcpServers": {
                                "project-stdio": {"command": "python3", "args": ["-c", "print('changed')"]}
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                loaded2 = core.load_servers_merged(script_file=None, cwd=project)
                self.assertNotIn("project-stdio", loaded2.servers)
                self.assertIn("project-stdio", loaded2.blocked_servers)


if __name__ == "__main__":
    unittest.main()
