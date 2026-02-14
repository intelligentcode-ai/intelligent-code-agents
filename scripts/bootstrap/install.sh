#!/usr/bin/env bash
set -euo pipefail

REPO="intelligentcode-ai/intelligent-code-agents"
INSTALL_DIR="${HOME}/.local/bin"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd tar
need_cmd node

sha256_file() {
  local file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi
  echo "ERROR: sha256 checksum tool not found (expected sha256sum or shasum)." >&2
  exit 1
}

release_json="$(curl --fail --location --silent --show-error "https://api.github.com/repos/${REPO}/releases/latest")"
version_tag="$(printf '%s' "${release_json}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [[ -z "${version_tag}" ]]; then
  echo "ERROR: unable to determine latest release tag." >&2
  exit 1
fi

artifact="ica-${version_tag}-source.tar.gz"
base_url="https://github.com/${REPO}/releases/latest/download"
artifact_url="${base_url}/${artifact}"
sums_url="${base_url}/SHA256SUMS.txt"

echo "Downloading ${artifact}..."
curl --fail --location --silent --show-error "${artifact_url}" --output "${TMP_DIR}/${artifact}"
curl --fail --location --silent --show-error "${sums_url}" --output "${TMP_DIR}/SHA256SUMS.txt"

echo "Verifying checksum..."
expected_checksum="$(awk -v target="${artifact}" '$2 == target {print tolower($1)}' "${TMP_DIR}/SHA256SUMS.txt" | head -n 1)"
actual_checksum="$(sha256_file "${TMP_DIR}/${artifact}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${expected_checksum}" || -z "${actual_checksum}" ]]; then
  echo "ERROR: failed to evaluate checksum values." >&2
  exit 1
fi
if [[ "${expected_checksum}" != "${actual_checksum}" ]]; then
  echo "ERROR: checksum verification failed for ${artifact}." >&2
  echo "Expected: ${expected_checksum}" >&2
  echo "Actual:   ${actual_checksum}" >&2
  exit 1
fi

INSTALL_ROOT="${HOME}/.ica/bootstrap/${version_tag}"
ENTRYPOINT="${INSTALL_ROOT}/dist/src/installer-cli/index.js"

echo "Installing ICA runtime to ${INSTALL_ROOT}"
mkdir -p "${INSTALL_DIR}" "${INSTALL_ROOT}"
tar -xzf "${TMP_DIR}/${artifact}" -C "${INSTALL_ROOT}" --strip-components=1

if [[ ! -f "${ENTRYPOINT}" ]]; then
  need_cmd npm
  (cd "${INSTALL_ROOT}" && npm ci --silent && npm run build:quick --silent)
fi

cat >"${INSTALL_DIR}/ica" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${ENTRYPOINT}" "\$@"
EOF
chmod 0755 "${INSTALL_DIR}/ica"

if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo "NOTICE: ${INSTALL_DIR} is not in PATH. Add this line to your shell profile:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo "ICA installed (${version_tag})."
echo "Next steps:"
echo "  1) Install skills/hooks: ica install"
echo "  2) Launch dashboard:    ica serve --open=true"
