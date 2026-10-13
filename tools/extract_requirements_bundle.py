#!/usr/bin/env python3
"""Safely extract the owner-supplied requirements/evaluation bundle.

Usage: extract_requirements_bundle.py <bundle.tar.gz> <destination-dir>

Safety rules (the bundle is supplied input, treated as untrusted):
  * absolute member paths are rejected;
  * any member whose normalised path escapes the destination is rejected;
  * symbolic links, hard links, devices and FIFOs are rejected outright
    (the supplied bundle contains only regular files and directories);
  * nothing is extracted unless every member passes.

Paths and file contents are preserved exactly; a manifest of SHA-256 hashes
of every extracted file is printed as JSON on stdout.
"""
import hashlib
import json
import os
import sys
import tarfile


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    bundle, dest = sys.argv[1], os.path.realpath(sys.argv[2])
    with tarfile.open(bundle, "r:gz") as tar:
        members = tar.getmembers()
        for m in members:
            name = m.name
            if name.startswith("/") or os.path.isabs(name) or (len(name) > 1 and name[1] == ":"):
                raise SystemExit(f"rejected absolute path: {name!r}")
            if not (m.isreg() or m.isdir()):
                raise SystemExit(f"rejected non-regular member (link/device): {name!r}")
            target = os.path.realpath(os.path.join(dest, name))
            if target != dest and not target.startswith(dest + os.sep):
                raise SystemExit(f"rejected path traversal: {name!r}")
            if ".." in name.replace("\\", "/").split("/"):
                raise SystemExit(f"rejected path traversal: {name!r}")
        manifest = []
        os.makedirs(dest, exist_ok=True)
        for m in members:
            target = os.path.join(dest, m.name)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(m)
            assert src is not None
            data = src.read()
            with open(target, "wb") as out:
                out.write(data)
            manifest.append({"path": m.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest.sort(key=lambda e: e["path"])
    json.dump({"bundle_sha256": hashlib.sha256(open(bundle, "rb").read()).hexdigest(), "files": manifest}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
