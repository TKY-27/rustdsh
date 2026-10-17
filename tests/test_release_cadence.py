"""Tests for scripts/prepare-cadence-release.py (offline, no network)."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


cadence = load("prepare_cadence_release", ROOT / "scripts" / "prepare-cadence-release.py")
release = load("prepare_release", ROOT / "scripts" / "prepare-release.py")

CHANGELOG = """# Changelog

## [Unreleased]

### Added

- A user-visible change.

## [1.2.3] - 2026-10-01

### Fixed

- An older change.
"""


class CadenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "docs" / "releases").mkdir(parents=True)
        (self.root / "Cargo.toml").write_text(
            '[package]' + chr(10) + 'name = "rdsh"' + chr(10) + 'version = "1.2.3"' + chr(10),
            encoding="utf-8")
        (self.root / "Cargo.lock").write_text(
            '[[package]]' + chr(10) + 'name = "rdsh"' + chr(10) + 'version = "1.2.3"' + chr(10),
            encoding="utf-8")
        (self.root / "CHANGELOG.md").write_text(CHANGELOG, encoding="utf-8")

    def test_stable_tags_are_compared_numerically(self):
        tags = ["v0.6.0", "v0.9.0", "v0.10.0", "v0.10.0-rc.1", "v0.2.0", "junk"]
        self.assertEqual(cadence.latest_stable(tags), "v0.10.0")
        self.assertEqual(cadence.next_patch("v0.10.0"), "v0.10.1")
        self.assertEqual(cadence.release_branch("v0.10.1"), "release/v0.10.1-prep")
        with self.assertRaises(ValueError):
            cadence.latest_stable(["v0.6.0-rc.1"])

    def test_unreleased_emptiness(self):
        empty = "# Changelog" + chr(10) * 2 + "## [Unreleased]" + chr(10) * 2 + "## [1.2.3] - 2026-10-01" + chr(10)
        self.assertFalse(cadence.has_release_content(empty))
        self.assertTrue(cadence.has_release_content(CHANGELOG))

    def test_promote_bumps_every_metadata_file(self):
        notes = cadence.promote(self.root, "v1.2.4", day="2026-10-17")
        self.assertEqual(notes.name, "v1.2.4.md")
        self.assertIn('version = "1.2.4"', (self.root / "Cargo.toml").read_text(encoding="utf-8"))
        self.assertIn('version = "1.2.4"', (self.root / "Cargo.lock").read_text(encoding="utf-8"))
        changelog = (self.root / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn("## [Unreleased]" + chr(10) * 2 + "## [1.2.4] - 2026-10-17", changelog)
        self.assertIn("## [1.2.3] - 2026-10-01", changelog)
        self.assertNotIn("## [Unreleased]" + chr(10) * 2 + "### Added", changelog)
        self.assertEqual(cadence.changelog_entries(cadence.unreleased_section(CHANGELOG)),
                         ["A user-visible change."])
        body = notes.read_text(encoding="utf-8")
        self.assertIn("<!-- previous-tag: v1.2.3 -->", body)
        self.assertIn("- A user-visible change.", body)

    def test_promoted_tree_passes_release_validation(self):
        cadence.promote(self.root, "v1.2.4", day="2026-10-17")
        release.validate(self.root, "v1.2.4")

    def test_promote_refuses_an_empty_unreleased(self):
        (self.root / "CHANGELOG.md").write_text(
            "# Changelog" + chr(10) * 2 + "## [Unreleased]" + chr(10) * 2
            + "## [1.2.3] - 2026-10-01" + chr(10), encoding="utf-8")
        with self.assertRaises(ValueError):
            cadence.promote(self.root, "v1.2.4", day="2026-10-17")

    def test_promote_refuses_a_mismatched_previous_tag(self):
        with self.assertRaises(ValueError):
            cadence.promote(self.root, "v1.2.4", previous="v1.1.0", day="2026-10-17")

    @unittest.skipUnless(shutil.which("git"), "git is required")
    def test_plan_reads_the_latest_tag_and_unreleased_state(self):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com",
                        "commit", "-qm", "init"], cwd=self.root, check=True)
        subprocess.run(["git", "tag", "v1.2.3"], cwd=self.root, check=True)
        output = self.root / "github-output.txt"
        values = cadence.plan(self.root, output)
        self.assertEqual(values, {"latest": "v1.2.3", "next": "v1.2.4",
                                  "branch": "release/v1.2.4-prep", "unreleased": "pending"})
        self.assertIn("unreleased=pending", output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

