#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <version-tag> [git-ref] [output-dir]" >&2
  echo "Example: $0 v10.2.9 HEAD dist" >&2
  exit 64
fi

VERSION_TAG="$1"
GIT_REF="${2:-HEAD}"
OUTPUT_DIR="${3:-dist}"

if [[ ! "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$ ]]; then
  echo "Invalid version tag: $VERSION_TAG (expected vX.Y.Z)" >&2
  exit 64
fi

mkdir -p "$OUTPUT_DIR"

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct "$GIT_REF")}"
export SOURCE_DATE_EPOCH
export TZ=UTC
export LC_ALL=C

PREFIX="intelligent-code-agents-${VERSION_TAG}/"
TAR_PATH="${OUTPUT_DIR}/ica-${VERSION_TAG}-source.tar.gz"
ZIP_PATH="${OUTPUT_DIR}/ica-${VERSION_TAG}-source.zip"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Building deterministic source archives from ${GIT_REF}"
git archive --format=tar --prefix="$PREFIX" "$GIT_REF" | gzip -n >"$TAR_PATH"
git archive --format=zip --prefix="$PREFIX" "$GIT_REF" >"$ZIP_PATH"

echo "Rebuilding once to verify reproducibility"
git archive --format=tar --prefix="$PREFIX" "$GIT_REF" | gzip -n >"${TMP_DIR}/rebuild.tar.gz"
git archive --format=zip --prefix="$PREFIX" "$GIT_REF" >"${TMP_DIR}/rebuild.zip"

if ! cmp -s "$TAR_PATH" "${TMP_DIR}/rebuild.tar.gz"; then
  echo "Reproducibility check failed for tar.gz artifact" >&2
  exit 1
fi
if ! cmp -s "$ZIP_PATH" "${TMP_DIR}/rebuild.zip"; then
  echo "Reproducibility check failed for zip artifact" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Need sha256sum or shasum to generate checksums" >&2
    exit 1
  fi
}

{
  printf "%s  %s\n" "$(sha256_file "$TAR_PATH")" "$(basename "$TAR_PATH")"
  printf "%s  %s\n" "$(sha256_file "$ZIP_PATH")" "$(basename "$ZIP_PATH")"
} | sort >"${OUTPUT_DIR}/SHA256SUMS.txt"

echo "Artifacts written to ${OUTPUT_DIR}"
