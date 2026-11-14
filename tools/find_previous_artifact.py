#!/usr/bin/env python3
"""Find the latest successful install run with an intermediate artifact.

Used by .github/workflows/install.yml before generating the incremental patch.
Prints "<run_id> <artifact_id> <created_at> <head_sha>" and exits 0 when found,
1 when no usable run exists, 2 on API errors.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ARTIFACT_NAME = "MaaEnd-win-x86_64-intermediate"
API_BASE = "https://api.github.com"
TIMEOUT_SECONDS = 60


def api_get(url: str, token: str | None) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "maaend-ci",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def main() -> int:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    branch = os.environ.get("BRANCH", "")
    current_run = os.environ.get("GITHUB_RUN_ID", "")
    token = os.environ.get("GITHUB_TOKEN") or None

    if not repository:
        print("GITHUB_REPOSITORY is not set", file=sys.stderr)
        return 2

    artifacts_url = (
        f"{API_BASE}/repos/{repository}/actions/artifacts"
        f"?name={urllib.parse.quote(ARTIFACT_NAME)}&per_page=100"
    )
    runs_url = f"{API_BASE}/repos/{repository}/actions/runs?status=success&per_page=50"
    if branch:
        runs_url += f"&branch={urllib.parse.quote(branch, safe='')}"

    try:
        artifacts = api_get(artifacts_url, token).get("artifacts", [])
        runs = api_get(runs_url, token).get("workflow_runs", [])
    except urllib.error.HTTPError as exc:
        print(f"GitHub API error {exc.code}: {exc.reason}", file=sys.stderr)
        return 2
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"GitHub API request failed: {exc}", file=sys.stderr)
        return 2

    successful_runs = {
        run.get("id") for run in runs if run.get("conclusion") == "success"
    }
    print(
        f"artifacts={len(artifacts)} successful_runs={len(successful_runs)} "
        f"branch={branch!r} current_run={current_run!r}",
        file=sys.stderr,
    )

    for item in sorted(
        artifacts, key=lambda artifact: artifact.get("created_at", ""), reverse=True
    ):
        run = item.get("workflow_run") or {}
        run_id = run.get("id")
        if item.get("expired"):
            print(f"skip expired artifact {item.get('id')}", file=sys.stderr)
            continue
        if current_run and str(run_id) == current_run:
            print(f"skip current run {run_id}", file=sys.stderr)
            continue
        if branch and run.get("head_branch") != branch:
            print(
                f"skip run {run_id} on branch {run.get('head_branch')!r}",
                file=sys.stderr,
            )
            continue
        if run_id not in successful_runs:
            print(f"skip run {run_id}: not a successful install run", file=sys.stderr)
            continue
        print(
            run_id,
            item.get("id"),
            item.get("created_at", ""),
            run.get("head_sha", ""),
        )
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
