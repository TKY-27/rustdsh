#!/usr/bin/env python3
"""Plan and prepare the next patch release for the release cadence.

`plan` reports the latest stable tag, the next patch tag, the preparation
branch and whether `[Unreleased]` has anything to release. `promote`
performs the mechanical part of a release preparation pull request: bump
`Cargo.toml` and the `rdsh` entry in `Cargo.lock`, promote the whole
`[Unreleased]` section into a dated entry, and write a
`docs/releases/vX.Y.Z.md` skeleton for review.

Tagging stays manual: docs/RELEASING.md keeps the tag on the exact SHA whose
required checks are green. This script never tags and never pushes.
"""
import argparse
from datetime import date as date_type
from pathlib import Path
import re
import subprocess
import tomllib


STABLE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
UNRELEASED = re.compile(r"^## \[Unreleased\]\n", re.M)
NEXT_ENTRY = re.compile(r"^## \[", re.M)
ROOT = Path(__file__).resolve().parents[1]

NOTES = """## {version} — CHANGELOG の [Unreleased] より生成

{changes}

## 更新前に確認

- 対応プラットフォームは Linux x86_64（glibc / musl）、macOS arm64・x86_64、Windows x86_64 です。
- 互換性と移行の要否はこの準備 PR で確定してください。破壊的変更がある場合は minor（vX.(Y+1).0）へ切り替えます。
- 更新後は既存の rustdsh プロセスを再起動してください。

Install/update:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

Windows では同じ Release の `install.ps1 -FromRelease` を使用してください。

<!-- この雛形は release-cadence workflow が生成しました。要約・互換性・移行の記述を公開前にレビューしてください。 -->
<!-- previous-tag: {previous} -->
"""


def parse_tag(tag):
    match = STABLE.fullmatch(tag)
    if not match:
        raise ValueError(f"tag must be vX.Y.Z: {tag!r}")
    return tuple(int(part) for part in match.groups())


def latest_stable(tags):
    versions = [(parse_tag(tag), tag) for tag in tags if STABLE.fullmatch(tag)]
    if not versions:
        raise ValueError("no stable vX.Y.Z tag found")
    return max(versions)[1]


def next_patch(tag):
    major, minor, patch = parse_tag(tag)
    return f"v{major}.{minor}.{patch + 1}"


def release_branch(tag):
    return f"release/{tag}-prep"


def unreleased_section(changelog):
    start = UNRELEASED.search(changelog)
    if not start:
        raise ValueError("CHANGELOG.md has no '## [Unreleased]' heading")
    rest = changelog[start.end():]
    end = NEXT_ENTRY.search(rest)
    return rest[: end.start()] if end else rest


def has_release_content(changelog):
    return any(line.strip() and not line.strip().startswith("#")
               for line in unreleased_section(changelog).splitlines())


def changelog_entries(body):
    entries = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            entries.append(stripped[2:].strip())
    return entries


def bump_manifest(root, version):
    path = root / "Cargo.toml"
    text = path.read_text(encoding="utf-8")
    current = tomllib.loads(text)["package"]["version"]
    if current == version:
        return current
    path.write_text(text.replace(f'version = "{current}"',
                                 f'version = "{version}"', 1), encoding="utf-8")
    return current


def bump_lock(root, version):
    path = root / "Cargo.lock"
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    named = False
    for index, line in enumerate(lines):
        if line.startswith("[[package]]"):
            named = False
        elif line.startswith('name = "rdsh"'):
            named = True
        elif named and line.startswith("version = "):
            lines[index] = f'version = "{version}"' + chr(10)
            path.write_text("".join(lines), encoding="utf-8")
            return
    raise ValueError('Cargo.lock has no version for package "rdsh"')


def promote_changelog(root, version, day):
    path = root / "CHANGELOG.md"
    text = path.read_text(encoding="utf-8")
    start = UNRELEASED.search(text)
    if not start:
        raise ValueError("CHANGELOG.md has no '## [Unreleased]' heading")
    rest = text[start.end():]
    end = NEXT_ENTRY.search(rest)
    body = (rest[: end.start()] if end else rest).strip(chr(10))
    if not body:
        raise ValueError("[Unreleased] has no entries to release")
    tail = rest[end.start():] if end else ""
    blank = chr(10) * 2
    path.write_text(f"{text[: start.start()]}## [Unreleased]{blank}"
                    f"## [{version}] - {day}{blank}{body}{blank}{tail}",
                    encoding="utf-8")
    return changelog_entries(body)


def notes_skeleton(root, tag, previous, entries):
    changes = chr(10).join(f"- {entry}" for entry in entries)
    if not changes:
        changes = "- CHANGELOG.md の該当バージョンの節を参照してください。"
    path = root / "docs" / "releases" / f"{tag}.md"
    path.write_text(NOTES.format(version=tag[1:], previous=previous,
                                 changes=changes), encoding="utf-8")
    return path


def plan(root, github_output=None):
    tags = subprocess.run(["git", "tag", "--list"], cwd=root, check=True,
                          text=True, capture_output=True).stdout.split()
    latest = latest_stable(tags)
    next_tag = next_patch(latest)
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    values = {
        "latest": latest,
        "next": next_tag,
        "branch": release_branch(next_tag),
        "unreleased": "pending" if has_release_content(changelog) else "empty",
    }
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as stream:
            stream.write("".join(f"{key}={value}" + chr(10)
                                 for key, value in values.items()))
    return values


def promote(root, tag, previous=None, day=None):
    parse_tag(tag)
    current = tomllib.loads((root / "Cargo.toml").read_text(
        encoding="utf-8"))["package"]["version"]
    previous = previous or f"v{current}"
    if previous != f"v{current}":
        raise ValueError(f"--previous-tag must be v{current} for the current tree")
    day = day or date_type.today().isoformat()
    bump_manifest(root, tag[1:])
    bump_lock(root, tag[1:])
    entries = promote_changelog(root, tag[1:], day)
    return notes_skeleton(root, tag, previous, entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "promote"))
    parser.add_argument("tag", nargs="?", help="next patch tag for promote")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--previous-tag", help="released tag the notes compare from")
    parser.add_argument("--date", help="release date for the CHANGELOG entry")
    parser.add_argument("--github-output", help="append plan values to this file")
    args = parser.parse_args()
    try:
        if args.command == "plan":
            for key, value in plan(args.root, args.github_output).items():
                print(f"{key}={value}")
        else:
            if not args.tag:
                parser.error("promote requires a tag")
            notes = promote(args.root, args.tag, args.previous_tag, args.date)
            print(f"prepared {args.tag}: {notes.relative_to(args.root)}")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"release cadence failed: {error}" + chr(10))


if __name__ == "__main__":
    main()

