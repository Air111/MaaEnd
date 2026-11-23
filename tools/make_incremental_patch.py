#!/usr/bin/env python3
"""Build overlay patches between two MaaEnd install trees.

Usage (in CI):
    uv run tools/make_incremental_patch.py \
        --old prev-install --new install \
        --out patch \
        --without-agent-out patch-without-agent \
        --agent-out agent-patch

All outputs are derived from one pair of tree scans. `--out` receives every
added/modified file, `--without-agent-out` omits `agent/`, and `--agent-out`
keeps only `agent/` files while preserving that prefix. This lets the CI upload
an agent-only delta, a resource-only patch, and a merged patch without hashing
the trees three times.

Each output directory keeps the install-relative layout, so extracting it over
an existing install updates added/modified files. Deleted files are handled only
when they actually exist: `_deleted-files.txt` and `_delete-old-files.ps1` are
written into the output root. Run the script against the install directory
before or after copying the overlay, then remove the two helper files.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import zipfile
from pathlib import Path

# Directories that are never part of the release package (user data / VCS).
EXCLUDED_TOP_DIRS = {"cache", "debug", "config", ".git"}
EXCLUDED_DIR_NAMES = {".git"}
EXCLUDED_FILE_NAMES = {"Thumbs.db", "desktop.ini", ".DS_Store"}
EXCLUDED_SUFFIXES = {".pdb", ".downloading"}

DELETE_LIST_NAME = "_deleted-files.txt"
DELETE_SCRIPT_NAME = "_delete-old-files.ps1"
EMPTY_MARKER_NAME = "no-changes.zip"
AGENT_PREFIX = "agent"

DELETE_SCRIPT = r"""param(
    [Parameter(Mandatory = $false)]
    [string]$Target = "."
)

$ErrorActionPreference = "Stop"
$targetRoot = [System.IO.Path]::GetFullPath($Target)
$targetPrefix = $targetRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$listPath = Join-Path $PSScriptRoot "_deleted-files.txt"
if (-not (Test-Path -LiteralPath $listPath -PathType Leaf)) {
    throw "missing $listPath"
}

$deleted = 0
$missing = 0
foreach ($line in Get-Content -LiteralPath $listPath -Encoding UTF8) {
    $rel = $line.Trim()
    if (-not $rel) { continue }
    if ([System.IO.Path]::IsPathRooted($rel)) { throw "absolute path is not allowed: $rel" }
    $segments = $rel -split '[\\/]'
    if ($segments -contains '..') { throw "parent path is not allowed: $rel" }

    $full = [System.IO.Path]::GetFullPath((Join-Path $targetRoot $rel))
    if (-not $full.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "path escapes target: $rel"
    }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
        Remove-Item -LiteralPath $full -Force
        Write-Host "deleted: $rel"
        $deleted++
    } else {
        Write-Host "missing (skip): $rel"
        $missing++
    }
}

Write-Host "done: deleted=$deleted missing=$missing"
"""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan(root: Path) -> dict[str, tuple[int, str]]:
    """Return {posix-relative-path: (size, sha256)} for release files."""
    result: dict[str, tuple[int, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        if not rel_dir.parts:
            dirnames[:] = [name for name in dirnames if name not in EXCLUDED_TOP_DIRS]
        dirnames[:] = [name for name in dirnames if name not in EXCLUDED_DIR_NAMES]

        for name in filenames:
            if name in EXCLUDED_FILE_NAMES:
                continue
            path = Path(dirpath) / name
            if path.suffix.lower() in EXCLUDED_SUFFIXES:
                continue
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            result[rel] = (path.stat().st_size, sha256(path))
    return result


def is_agent_path(rel: str) -> bool:
    return rel == AGENT_PREFIX or rel.startswith(AGENT_PREFIX + "/")


def write_delete_helpers(out_dir: Path, deleted: list[str]) -> None:
    (out_dir / DELETE_LIST_NAME).write_text("\n".join(deleted) + "\n", encoding="utf-8")
    (out_dir / DELETE_SCRIPT_NAME).write_text(DELETE_SCRIPT, encoding="utf-8")


def print_paths(title: str, paths: list[str], limit: int = 30) -> None:
    if not paths:
        return
    print(f"{title} ({len(paths)}):")
    for path in paths[:limit]:
        print(f"  {path}")
    if len(paths) > limit:
        print(f"  ... {len(paths) - limit} more")


def write_output(
    out_dir: Path,
    new_dir: Path,
    added: list[str],
    modified: list[str],
    deleted: list[str],
    empty_marker: str,
    label: str,
) -> None:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    if not added and not modified and not deleted:
        if empty_marker:
            marker_path = out_dir / empty_marker
            with zipfile.ZipFile(marker_path, "w") as archive:
                archive.comment = b"no changes"
            print(f"{label}: no changes; wrote empty marker {empty_marker}")
        else:
            print(f"{label}: no changes")
        return

    copied_bytes = 0
    for rel in added + modified:
        source = new_dir / rel
        target = out_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied_bytes += target.stat().st_size

    if deleted:
        write_delete_helpers(out_dir, deleted)

    print(f"{label}: added={len(added)} modified={len(modified)} deleted={len(deleted)} payload={copied_bytes} bytes")
    print_paths(f"{label} added", added)
    print_paths(f"{label} modified", modified)
    print_paths(f"{label} deleted", deleted)
    if deleted:
        print(f"{label} delete helpers: {DELETE_LIST_NAME}, {DELETE_SCRIPT_NAME}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", type=Path, required=True, help="previous install tree")
    parser.add_argument("--new", type=Path, required=True, help="new install tree")
    parser.add_argument("--out", type=Path, required=True, help="full patch output directory")
    parser.add_argument(
        "--without-agent-out",
        type=Path,
        help="optional patch output directory with agent/ files omitted",
    )
    parser.add_argument(
        "--agent-out",
        type=Path,
        help="optional agent-only output directory, preserving the agent/ prefix",
    )
    parser.add_argument(
        "--empty-marker",
        default=EMPTY_MARKER_NAME,
        help=("file name for a valid empty zip written when there is no change; pass an empty string to disable"),
    )
    args = parser.parse_args()

    if args.empty_marker and Path(args.empty_marker).name != args.empty_marker:
        parser.error("--empty-marker must be a file name, not a path")

    old_dir = args.old.resolve()
    new_dir = args.new.resolve()
    out_dir = args.out.resolve()
    output_specs = [("--out", out_dir)]
    if args.without_agent_out is not None:
        output_specs.append(("--without-agent-out", args.without_agent_out.resolve()))
    if args.agent_out is not None:
        output_specs.append(("--agent-out", args.agent_out.resolve()))

    for name, path in (("--old", old_dir), ("--new", new_dir)):
        if not path.is_dir():
            parser.error(f"{name} is not a directory: {path}")

    for name, path in output_specs:
        if path in (old_dir, new_dir):
            parser.error(f"{name} must not be the same as --old or --new")
        if old_dir in path.parents or new_dir in path.parents:
            parser.error(f"{name} must not be inside --old or --new")
        if path in old_dir.parents or path in new_dir.parents:
            parser.error(f"{name} must not contain --old or --new")

    for index, (name, path) in enumerate(output_specs):
        for other_name, other_path in output_specs[index + 1 :]:
            if path == other_path:
                parser.error(f"{name} and {other_name} must be different")
            if path in other_path.parents or other_path in path.parents:
                parser.error(f"{name} and {other_name} must not be nested")

    old_files = scan(old_dir)
    new_files = scan(new_dir)

    old_set = set(old_files)
    new_set = set(new_files)
    added = sorted(new_set - old_set)
    # The patch is applied on Windows, where paths are case-insensitive: a
    # case-only rename shows up as added + deleted, but copying the new spelling
    # already overwrites the old file, so deleting it again would remove the new one.
    new_lower = {rel.lower() for rel in new_set}
    deleted = sorted(rel for rel in old_set - new_set if rel.lower() not in new_lower)
    modified = sorted(rel for rel in old_set & new_set if old_files[rel] != new_files[rel])

    print(f"changed: added={len(added)} modified={len(modified)} deleted={len(deleted)}")
    write_output(out_dir, new_dir, added, modified, deleted, args.empty_marker, "full patch")

    if args.without_agent_out is not None:
        write_output(
            args.without_agent_out.resolve(),
            new_dir,
            [rel for rel in added if not is_agent_path(rel)],
            [rel for rel in modified if not is_agent_path(rel)],
            [rel for rel in deleted if not is_agent_path(rel)],
            args.empty_marker,
            "patch without agent",
        )

    if args.agent_out is not None:
        write_output(
            args.agent_out.resolve(),
            new_dir,
            [rel for rel in added if is_agent_path(rel)],
            [rel for rel in modified if is_agent_path(rel)],
            [rel for rel in deleted if is_agent_path(rel)],
            args.empty_marker,
            "agent patch",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
