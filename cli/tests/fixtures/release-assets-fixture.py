"""Offline packages and a fake gh executable for release-gate regressions."""
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

BINDINGS = {
    "x86_64-unknown-linux-gnu": "evot-napi.linux-x64-gnu.node",
    "aarch64-unknown-linux-gnu": "evot-napi.linux-arm64-gnu.node",
    "aarch64-apple-darwin": "evot-napi.darwin-arm64.node",
    "x86_64-apple-darwin": "evot-napi.darwin-x64.node",
}


def create(root: Path, tag: str, scenario: str) -> None:
    assets = []
    for index, (target, binding) in enumerate(BINDINGS.items()):
        archive = root / f"evot-{tag}-{target}.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            for name in ("bin/evot", f"lib/{binding}"):
                if index == 0 and scenario == "missing-binary" and name == "bin/evot":
                    continue
                if index == 0 and scenario == "wrong-binding" and name.startswith("lib/"):
                    name = "lib/evot-napi.darwin-arm64.node"
                entry = tarfile.TarInfo(name)
                entry.size = 7
                entry.mode = 0o644 if scenario == "not-executable" and index == 0 else 0o755
                if index == 0 and scenario == "symlink" and name == "bin/evot":
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "/unrelated/evot"
                    entry.size = 0
                package.addfile(entry, io.BytesIO(b"fixture"))
        if index == 0 and scenario == "corrupt-archive":
            archive.write_bytes(b"not a tar archive")
        checksum = Path(str(archive) + ".sha256")
        checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "\n")
        if index == 0 and scenario == "bad-checksum":
            checksum.write_text("0" * 64 + "\n")
        if index == 0 and scenario == "invalid-checksum":
            checksum.write_text("not a sha256\n")
        for path in (archive, checksum):
            assets.append({"name": path.name, "state": "uploaded", "size": path.stat().st_size})
    if scenario == "missing-package":
        assets.pop(0)
    elif scenario == "missing-checksum":
        assets.pop(1)
    elif scenario == "incomplete-upload":
        assets[0]["state"] = "new"
    elif scenario == "empty-upload":
        assets[0]["size"] = 0
    elif scenario == "duplicate":
        assets.append(assets[0].copy())
    (root / "assets.json").write_text(json.dumps({"assets": assets}))


def gh(args: list[str]) -> None:
    root = Path(os.environ["EVOT_RELEASE_FIXTURE"])
    with (root / "commands.jsonl").open("a") as log:
        log.write(json.dumps(args) + "\n")
    if args[:2] == ["release", "view"]:
        print((root / "assets.json").read_text())
    elif args[:2] == ["release", "download"]:
        failure = os.environ.get("EVOT_RELEASE_DOWNLOAD_FAIL")
        destination = Path(args[args.index("--dir") + 1])
        marker = root / "download-attempted"
        if failure == "1" or (failure == "once" and not marker.exists()):
            marker.touch()
            (destination / args[args.index("--pattern") + 1]).write_bytes(b"partial")
            sys.exit(1)
        for index, arg in enumerate(args):
            if arg == "--pattern":
                source = root / args[index + 1]
                shutil.copyfile(source, destination / source.name)
    else:
        raise ValueError(f"unexpected gh call: {args}")


if sys.argv[1] == "create":
    create(Path(sys.argv[2]), sys.argv[3], sys.argv[4])
else:
    gh(sys.argv[1:])
