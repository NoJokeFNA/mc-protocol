#!/usr/bin/env python3
"""Syncs protocol data from derklaro/mc-protocol into static JSON files.

Fetches commits from the gh-pages branch, identifies protocol update commits,
downloads the readme.md for each new version, parses it, and writes structured
JSON files into the output directory.

Usage:
    python sync.py --output gh-pages/data/

Environment:
    GITHUB_TOKEN  — optional, raises rate limit from 60 to 5000/h
"""

import argparse
import json
import os
import re
from pathlib import Path

import requests

from parser import extract_raw_markdown, parse_readme

OWNER = "derklaro"
REPO = "mc-protocol"
BRANCH = "gh-pages"
API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"


def get_headers() -> dict[str, str]:
    """Builds request headers with optional authentication."""
    headers = {"Accept": "application/vnd.github.v3+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"
    return headers


def fetch_all_commits() -> list[dict]:
    """Fetches all commits from the gh-pages branch."""
    headers = get_headers()
    all_commits = []
    page = 1

    while True:
        url = (
            f"{API}/repos/{OWNER}/{REPO}/commits"
            f"?sha={BRANCH}&page={page}&per_page=100"
        )
        print(f"  Fetching commits page {page}...")
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        all_commits.extend(data)
        if len(data) < 100:
            break
        page += 1
        if page > 50:
            break

    return all_commits


def classify_version(version: str) -> str:
    """Classifies a version string as stable, prerelease, or snapshot.

    Handles multiple naming conventions:
      - Pre-releases: "1.21.2-pre1", "1.21.2-rc1"
      - Old snapshots: "24w45a", "22w44a"
      - New snapshots: "26.1-snapshot-1", "25.2-snapshot.3"
      - Stable: "1.20.5", "1.21.4"
    """
    v = version.lower()
    if "-pre" in v or "-rc" in v:
        return "prerelease"
    if "-snapshot" in v:
        return "snapshot"
    if re.match(r"\d{2}w\d+[a-z]", v):
        return "snapshot"
    return "stable"


def is_valid_version(version: str) -> bool:
    """Checks if a version string is a real version, not a template placeholder."""
    if not version or version.startswith("$") or version.startswith("{"):
        return False
    if version.lower() in ("version", "unknown", "test", "example"):
        return False
    return True


def extract_versions(commits: list[dict]) -> list[dict]:
    """Filters commits to protocol updates and extracts version info."""
    pattern = re.compile(r"^Update protocol for (.+)$")
    versions = []

    for commit in commits:
        msg = commit["commit"]["message"].strip()
        first_line = msg.split("\n")[0]
        m = pattern.match(first_line)
        if not m:
            continue

        version = m.group(1).strip()
        if not is_valid_version(version):
            print(f"  Skipping invalid version string: '{version}'")
            continue
        date_str = commit["commit"]["committer"]["date"]
        versions.append({
            "version": version,
            "sha": commit["sha"],
            "date": date_str,
            "kind": classify_version(version),
        })

    # Sort by date ascending
    versions.sort(key=lambda v: v["date"])
    return versions


def fetch_readme(sha: str) -> str:
    """Fetches the readme.md for a specific commit SHA.

    Tries with SSL verification first, falls back to unverified if
    GitHub's raw CDN returns an SSL error (happens with some older commits).
    """
    url = f"{RAW}/{OWNER}/{REPO}/{sha}/readme.md"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        return resp.text
    except requests.exceptions.SSLError:
        # Retry without SSL verification as fallback
        resp = requests.get(url, timeout=30, verify=False)
        resp.raise_for_status()
        return resp.text


def load_existing_versions(output_dir: Path) -> dict[str, dict]:
    """Loads the existing versions.json index if it exists."""
    versions_file = output_dir / "versions.json"
    if versions_file.exists():
        with open(versions_file) as f:
            data = json.load(f)
        return {v["sha"]: v for v in data.get("versions", [])}
    return {}


def version_json_path(output_dir: Path, version_info: dict) -> Path:
    """Returns the path for a version's JSON file."""
    kind = version_info["kind"]
    # Sanitize version string for filename
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", version_info["version"])
    return output_dir / kind / f"{safe_name}.json"


def sync(output_dir: Path) -> None:
    """Main sync logic."""
    output_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("stable", "prerelease", "snapshot"):
        (output_dir / sub).mkdir(exist_ok=True)

    print("Fetching commits from derklaro/mc-protocol...")
    commits = fetch_all_commits()
    print(f"  Found {len(commits)} total commits")

    versions = extract_versions(commits)
    print(f"  Found {len(versions)} protocol update commits")

    existing = load_existing_versions(output_dir)
    print(f"  {len(existing)} versions already cached")

    new_count = 0
    updated_versions = []

    for v in versions:
        json_path = version_json_path(output_dir, v)

        if v["sha"] in existing and json_path.exists():
            # Already have this version, keep existing metadata
            updated_versions.append(existing[v["sha"]])
            continue

        # New version — fetch and parse
        print(f"  Syncing {v['version']} ({v['sha'][:7]})...")
        try:
            readme_text = fetch_readme(v["sha"])
        except requests.RequestException as e:
            print(f"    ERROR fetching readme: {e}")
            # Keep existing if available
            if v["sha"] in existing:
                updated_versions.append(existing[v["sha"]])
            continue

        # Parse structured data
        parsed = parse_readme(readme_text)

        # Extract raw markdown blocks per packet
        raw_blocks = extract_raw_markdown(readme_text)

        # Build the version JSON
        version_data = {
            "version": v["version"],
            "kind": v["kind"],
            "sha": v["sha"],
            "date": v["date"],
            "protocol": parsed.get("protocol"),
            "worldVersion": parsed.get("worldVersion"),
            "javaVersion": parsed.get("javaVersion"),
            "resourcePackVersion": parsed.get("resourcePackVersion"),
            "dataPackVersion": parsed.get("dataPackVersion"),
            "buildTime": parsed.get("buildTime"),
            "title": parsed.get("title"),
            "sections": parsed["sections"],
            "rawBlocks": raw_blocks,
        }

        # Write version JSON
        with open(json_path, "w") as f:
            json.dump(version_data, f, separators=(",", ":"))

        # Build index entry (without heavy data)
        index_entry = {
            "version": v["version"],
            "kind": v["kind"],
            "sha": v["sha"],
            "date": v["date"],
            "protocol": parsed.get("protocol"),
            "file": str(json_path.relative_to(output_dir)),
        }
        updated_versions.append(index_entry)
        new_count += 1

    # For existing versions that weren't re-processed, ensure index entries
    # have the 'file' field (migration from old format)
    for entry in updated_versions:
        if "file" not in entry:
            kind = entry.get("kind", "stable")
            safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", entry["version"])
            entry["file"] = f"{kind}/{safe_name}.json"

    # Write versions index
    index_data = {
        "source": f"https://github.com/{OWNER}/{REPO}",
        "branch": BRANCH,
        "count": len(updated_versions),
        "versions": updated_versions,
    }
    with open(output_dir / "versions.json", "w") as f:
        json.dump(index_data, f, indent=2)

    print(f"\nDone. {new_count} new version(s) synced, "
          f"{len(updated_versions)} total in index.")


def main():
    arg_parser = argparse.ArgumentParser(
        description="Sync mc-protocol data to static JSON files"
    )
    arg_parser.add_argument(
        "--output", "-o",
        default="data",
        help="Output directory for JSON files (default: data/)",
    )
    args = arg_parser.parse_args()
    sync(Path(args.output))


if __name__ == "__main__":
    main()
