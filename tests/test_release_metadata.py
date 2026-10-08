import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "prepare_release", Path(__file__).resolve().parents[1] / "scripts" / "prepare-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "docs" / "releases").mkdir(parents=True)

    def fixture(self, version="1.2.3"):
        (self.root / "Cargo.toml").write_text(f'[package]\nname = "rdsh"\nversion = "{version}"\n')
        (self.root / "Cargo.lock").write_text(f'[[package]]\nname = "rdsh"\nversion = "{version}"\n')
        (self.root / "CHANGELOG.md").write_text(f"## [{version}] - 2026-10-08\n")
        notes = (f"## {version} — Example\n\n- Fixed an issue.\n\n## 更新前に確認\n\n"
                 "- Restart processes.\n\nInstall/update:\n\n```sh\ncurl https://example.com/install.sh\n```\n\n"
                 "Windows: `install.ps1 -FromRelease`.\n")
        path = self.root / "docs" / "releases" / f"v{version}.md"
        path.write_text(notes)
        return path

    def test_stable_and_prerelease(self):
        for version in ("1.2.3", "1.2.3-rc.1", "1.2.3-beta.0", "1.2.3-alpha.2"):
            self.fixture(version)
            release.validate(self.root, f"v{version}")

    def test_invalid_tags(self):
        for tag in ("1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc", "v1.2.3-rc.01", "v1.2.3+build", "v1.2.3\n"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "tag must"):
                release.validate(self.root, tag)

    def test_manifest_and_lock_must_match_tag(self):
        self.fixture()
        for filename in ("Cargo.toml", "Cargo.lock"):
            path = self.root / filename
            original = path.read_text()
            path.write_text(original.replace("1.2.3", "1.2.4"))
            with self.assertRaisesRegex(ValueError, "versions must match"):
                release.validate(self.root, "v1.2.3")
            path.write_text(original)

    def test_missing_changelog_or_notes(self):
        notes = self.fixture()
        (self.root / "CHANGELOG.md").write_text("## [Unreleased]\n")
        with self.assertRaisesRegex(ValueError, "dated entry"):
            release.validate(self.root, "v1.2.3")
        self.fixture()
        notes.unlink()
        with self.assertRaises(FileNotFoundError):
            release.validate(self.root, "v1.2.3")

    def test_missing_sections_wrong_heading_and_placeholders(self):
        for old, new in (("## 更新前に確認", "## Notes"), ("Install/update:", "Install:"),
                         ("1.2.3 — Example", "1.2.4 — Example"), ("Fixed an issue.", "<changes>"),
                         ("Fixed an issue.", "TODO"), ("install.ps1", "install.cmd")):
            notes = self.fixture()
            notes.write_text(notes.read_text().replace(old, new))
            with self.subTest(old=old), self.assertRaises(ValueError):
                release.validate(self.root, "v1.2.3")

    def test_generated_notes_are_replaced_without_duplicate_credits(self):
        notes = self.fixture()
        notes.write_text(notes.read_text() + "\n## What's Changed\n\nold PR list\n")
        authored = release.validate(self.root, "v1.2.3")
        generated = ("## What's Changed\n### What's Changed\n* Fix by @contributor in https://github.com/org/repo/pull/1\n\n"
                     "## New Contributors\n\n* @contributor\n\n"
                     "**Full Changelog**: https://github.com/org/repo/compare/v1.2.2...v1.2.3")
        rendered = release.compose(authored, generated, "org/repo")
        self.assertEqual(rendered.count("## What's Changed"), 1)
        self.assertNotIn("### What's Changed", rendered)
        self.assertIn(generated.replace("\n### What's Changed\n", "\n\n"), rendered)
        self.assertNotIn("old PR list", rendered)
        self.assertIn("https://github.com/org/repo/blob/main/CHANGELOG.md", rendered)

    def test_incomplete_generated_notes_are_refused(self):
        for generated in ("", "## What's Changed\n", "**Full Changelog**: url"):
            with self.assertRaises(ValueError):
                release.compose("notes", generated, "org/repo")

    def test_prerelease_cannot_recommend_latest_installer(self):
        notes = self.fixture("1.2.3-rc.1")
        notes.write_text(notes.read_text().replace("https://example.com/install.sh",
                         "https://github.com/org/repo/releases/latest/download/install.sh"))
        with self.assertRaisesRegex(ValueError, "exact tag URL"):
            release.validate(self.root, "v1.2.3-rc.1")


if __name__ == "__main__":
    unittest.main()
