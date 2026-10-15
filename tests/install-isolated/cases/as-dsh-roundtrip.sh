#!/usr/bin/env bash
# --as-dsh shadows an existing dsh with a backup, --restore puts it back.
set -euo pipefail
. /cases/lib.sh

mkdir -p "$PREFIX"
printf '#!/bin/sh\necho "original-dsh $*"\n' > "$PREFIX/dsh"
chmod 755 "$PREFIX/dsh"

install_out="$(install_rdsh --from-release --as-dsh)"
printf '%s\n' "$install_out"
# バイナリの rdsh/dsh は "node" と "dsh" を両方含むので、テキストのラッパーが
# 無いのに node ラッパー警告が出たら誤検知（grep -I で走査対象から外す）。
case "$install_out" in
  *"wrappers calling 'node"*)
    echo "spurious node-wrapper note without a text wrapper" >&2
    exit 1
    ;;
esac
[ -x "$PREFIX/dsh-orig" ] || { echo "no dsh-orig backup" >&2; exit 1; }
# `dsh --version` is delegated verbatim to the original dsh by design, so the
# shadowing check uses a native command instead.
out="$("$PREFIX/dsh" doctor 2>&1)"
case "$out" in *rdsh*) ;; *) echo "dsh is not rdsh after --as-dsh: $out" >&2; exit 1 ;; esac
expect_version

# A standalone install may update rdsh while the owned dsh shadow stays at its
# earlier build. Both archives are genuine staged release builds for this case.
shadow_sum="$(sha256sum "$PREFIX/dsh" | awk '{print $1}')"
install_rdsh --from-release --musl
updated_sum="$(sha256sum "$PREFIX/rdsh" | awk '{print $1}')"
[ "$updated_sum" != "$shadow_sum" ] || { echo "update fixture did not use a different build" >&2; exit 1; }
[ "$(sha256sum "$PREFIX/dsh" | awk '{print $1}')" = "$shadow_sum" ] || { echo "standalone update changed the dsh shadow" >&2; exit 1; }

# Receipts are raw ASCII records; Bash read must not silently discard NUL bytes.
receipt="$PREFIX/.rdsh-dsh-shadow"
IFS= read -r receipt_line < "$receipt"
backup_sum="$(sha256sum "$PREFIX/dsh-orig" | awk '{print $1}')"
for nul_position in in after; do
  if [ "$nul_position" = in ]; then
    printf '%s\0%s\n' "${receipt_line:0:32}" "${receipt_line:32}" > "$receipt"
  else
    printf '%s\n\0' "$receipt_line" > "$receipt"
  fi
  invalid_receipt_sum="$(sha256sum "$receipt" | awk '{print $1}')"
  if bash /install.sh --restore; then
    echo "restore accepted a NUL $nul_position the receipt" >&2
    exit 1
  fi
  [ "$(sha256sum "$PREFIX/dsh" | awk '{print $1}')" = "$shadow_sum" ] || { echo "refused restore changed the dsh shadow" >&2; exit 1; }
  [ "$(sha256sum "$PREFIX/dsh-orig" | awk '{print $1}')" = "$backup_sum" ] || { echo "refused restore changed the original backup" >&2; exit 1; }
  [ "$(sha256sum "$receipt" | awk '{print $1}')" = "$invalid_receipt_sum" ] || { echo "refused restore changed the receipt" >&2; exit 1; }
done
printf '%s\n' "$receipt_line" > "$receipt"

bash /install.sh --restore
out="$("$PREFIX/dsh")"
case "$out" in original-dsh*) ;; *) echo "restore did not bring the original dsh back: $out" >&2; exit 1 ;; esac
expect_version
echo "CASE OK: as-dsh-roundtrip"
