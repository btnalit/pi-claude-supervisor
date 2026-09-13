#!/usr/bin/env bash
set -euo pipefail
# Pinned tool and checksum; never execute an unverified curl|sh installer.
version=1.7.12
case "$(uname -m)" in
  x86_64|amd64)
    asset_arch=amd64
    checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    ;;
  aarch64|arm64)
    asset_arch=arm64
    checksum=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
    ;;
  *)
    echo "Unsupported actionlint host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 2 --max-time 60 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_${asset_arch}.tar.gz" \
  --output "$work/actionlint.tar.gz"
printf '%s  %s\n' "$checksum" "$work/actionlint.tar.gz" | sha256sum --check --status
tar -xzf "$work/actionlint.tar.gz" -C "$work" actionlint
"$work/actionlint" -color
