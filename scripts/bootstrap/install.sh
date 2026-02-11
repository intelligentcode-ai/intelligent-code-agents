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

os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch_name="$(uname -m)"

case "${arch_name}" in
  x86_64|amd64) arch_name="x64" ;;
  aarch64|arm64) arch_name="arm64" ;;
  *)
    echo "ERROR: unsupported architecture: ${arch_name}" >&2
    exit 1
    ;;
esac

case "${os_name}" in
  darwin) os_name="darwin" ;;
  linux) os_name="linux" ;;
  *)
    echo "ERROR: unsupported OS: ${os_name}" >&2
    exit 1
    ;;
esac

artifact="ica-${os_name}-${arch_name}.tar.gz"
base_url="https://github.com/${REPO}/releases/latest/download"
artifact_url="${base_url}/${artifact}"
checksum_url="${base_url}/${artifact}.sha256"

echo "Downloading ${artifact}..."
curl --fail --location --silent --show-error "${artifact_url}" --output "${TMP_DIR}/${artifact}"
curl --fail --location --silent --show-error "${checksum_url}" --output "${TMP_DIR}/${artifact}.sha256"

echo "Verifying checksum..."
expected_checksum="$(awk '{print $1}' "${TMP_DIR}/${artifact}.sha256" | tr '[:upper:]' '[:lower:]')"
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

echo "Installing ICA CLI to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
tar -xzf "${TMP_DIR}/${artifact}" -C "${TMP_DIR}"
install -m 0755 "${TMP_DIR}/ica" "${INSTALL_DIR}/ica"

if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo "NOTICE: ${INSTALL_DIR} is not in PATH. Add this line to your shell profile:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo "ICA installed. Launching interactive install..."
"${INSTALL_DIR}/ica" install
