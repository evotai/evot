#!/usr/bin/env python3
"""Fail closed before publishing: verify every supported platform's remote package."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path


TARGET_BINDINGS = {
    "x86_64-unknown-linux-gnu": "evot-napi.linux-x64-gnu.node",
    "aarch64-unknown-linux-gnu": "evot-napi.linux-arm64-gnu.node",
    "aarch64-apple-darwin": "evot-napi.darwin-arm64.node",
    "x86_64-apple-darwin": "evot-napi.darwin-x64.node",
}


def verify_release(tag: str, repo: str) -> None:
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-beta\.[0-9]+)?", tag):
        raise ValueError(f"invalid release tag: {tag!r}")
    packages = {
        f"evot-{tag}-{target}.tar.gz": binding
        for target, binding in TARGET_BINDINGS.items()
    }
    required = [name for archive in packages for name in (archive, archive + ".sha256")]
    result = subprocess.run(
        ["gh", "release", "view", tag, "--repo", repo, "--json", "assets"],
        check=True, capture_output=True, text=True, timeout=60,
    )
    assets = json.loads(result.stdout)["assets"]
    # Do not trust a filename alone: an empty or incomplete upload is not an asset.
    for name in required:
        matches = [asset for asset in assets if asset.get("name") == name]
        if len(matches) != 1:
            raise ValueError(f"expected exactly one release asset: {name}")
        asset = matches[0]
        if asset.get("state") != "uploaded" or asset.get("size", 0) <= 0:
            raise ValueError(f"release asset is empty or not uploaded: {name}")

    with tempfile.TemporaryDirectory(prefix="evot-release-check-") as directory:
        # Retry one asset at a time: a transient CDN failure should neither
        # discard other successful downloads nor leave a partial file trusted.
        for name in required:
            print(f"Downloading {name}", flush=True)
            command = ["gh", "release", "download", tag, "--repo", repo,
                       "--dir", directory, "--pattern", name, "--clobber"]
            for attempt in range(3):
                try:
                    subprocess.run(command, check=True, timeout=180)
                    break
                except subprocess.SubprocessError:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
        root = Path(directory)
        for name, binding in packages.items():
            archive = root / name
            checksum = root / (name + ".sha256")
            expected = checksum.read_text(encoding="ascii").strip()
            if not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
                raise ValueError(f"invalid SHA-256 file: {checksum.name}")
            digest = hashlib.sha256()
            with archive.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected.lower():
                raise ValueError(f"SHA-256 mismatch: {name}")
            # Inspect without extracting or executing a downloaded package.
            with tarfile.open(archive, "r:gz") as package:
                members = package.getmembers()
                for required_path in ("bin/evot", f"lib/{binding}"):
                    matches = [member for member in members if member.name == required_path]
                    if len(matches) != 1 or not matches[0].isfile() or matches[0].size <= 0:
                        raise ValueError(f"missing or invalid {required_path} in {name}")
                    if required_path == "bin/evot" and not matches[0].mode & 0o111:
                        raise ValueError(f"bin/evot is not executable in {name}")
                bindings = {member.name for member in members if member.name.endswith(".node")}
                if bindings != {f"lib/{binding}"}:
                    raise ValueError(f"unexpected native bindings in {name}")
            print(f"Verified {name}", flush=True)
    print(f"All {len(packages)} platform packages and checksums verified for {tag}.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--repo", required=True)
    args = parser.parse_args()
    try:
        verify_release(args.tag, args.repo)
    except (OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
