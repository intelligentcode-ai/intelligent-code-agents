import asyncio
import sys
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


class TestMcpCoreSecurity(unittest.TestCase):
    def test_validate_secure_url_blocks_plain_http_non_loopback(self):
        core = _load_core()
        with self.assertRaises(ValueError):
            core._validate_secure_url("http://example.com/token", field="oauth.token_url", allow_http_loopback=True)

    def test_validate_secure_url_allows_loopback_http_for_dev(self):
        core = _load_core()
        core._validate_secure_url("http://127.0.0.1:8080/token", field="oauth.token_url", allow_http_loopback=True)

    def test_pkce_rejects_non_loopback_redirect_host(self):
        core = _load_core()
        cfg = {
            "oauth": {
                "type": "pkce",
                "authorization_url": "https://auth.example.com/authorize",
                "token_url": "https://auth.example.com/token",
                "client_id": "abc123",
                "redirect_uri": "http://0.0.0.0:8765/callback",
                "scopes": ["openid"],
            }
        }
        with self.assertRaises(ValueError):
            asyncio.run(core.oauth_auth_pkce("test-server", cfg, script_file=None))

    def test_client_credentials_rejects_http_token_endpoint(self):
        core = _load_core()
        cfg = {
            "oauth": {
                "type": "client_credentials",
                "token_url": "http://example.com/oauth/token",
                "client_id": "cid",
                "client_secret": "secret",
            }
        }
        with self.assertRaises(ValueError):
            asyncio.run(core.oauth_auth_client_credentials("test-server", cfg, script_file=None))


if __name__ == "__main__":
    unittest.main()
