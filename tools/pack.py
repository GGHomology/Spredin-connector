#!/usr/bin/env python3
"""Build dist/spredin-connector-<version>.mcpb, the file a user installs.

The .mcpb is built from the COMMITTED tree (`git archive HEAD`), never from
whatever happens to be in the working folder, so a release is exactly a
commit. A working tree with uncommitted or untracked files is refused, unless
--allow-dirty is given; even then only HEAD is packed, and it says so.

An .mcpb is a zip with manifest.json at its root (MCPB README, "Directory
Structures"). This writes it as the official `mcpb pack` does (deflate,
level 9, Unix permissions in each entry), from an explicit list of the files
the extension needs, in a fixed order with a fixed timestamp, so the same
commit always gives the same bytes:

    manifest.json  package.json  icon.png  LICENSE  README.md  server/**

package.json goes in because it says "type": "module", which is what makes
Node load server/*.js as ES modules.

    python3 tools/pack.py                 # -> dist/
    python3 tools/pack.py --out DIR       # somewhere else (the tests use this)
    python3 tools/pack.py --allow-dirty   # pack HEAD although the tree has changes

It prints the commit, the file's size and its SHA-256, for the release notes.
Standard library only; needs git.
"""

import argparse
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP_FILES = ["manifest.json", "package.json", "icon.png", "LICENSE", "README.md"]
SERVER_DIR = "server"
STAMP = (1980, 1, 1, 0, 0, 0)  # the earliest a zip can say


def fail(msg):
    print(f"pack: {msg}", file=sys.stderr)
    sys.exit(1)


def git(*args, binary=False):
    try:
        r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, check=False)
    except FileNotFoundError:
        fail("git is needed to pack (the .mcpb is built from the committed tree)")
    if r.returncode != 0:
        fail(f"git {' '.join(args)} failed: {r.stderr.decode('utf-8', 'replace').strip()}")
    return r.stdout if binary else r.stdout.decode("utf-8").strip()


def committed_files():
    """The extension's files as HEAD has them: {path: bytes}."""
    tar = git("archive", "--format=tar", "HEAD", "--", *TOP_FILES, SERVER_DIR, binary=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            name = m.name
            if os.path.basename(name).startswith(".") or "__pycache__" in name.split("/"):
                continue
            files[name] = t.extractfile(m).read()
    for rel in TOP_FILES:
        if rel not in files:
            fail(f"{rel} is not in HEAD")
    return files


def check(files):
    manifest = json.loads(files["manifest.json"])
    package = json.loads(files["package.json"])
    if manifest.get("manifest_version") != "0.3":
        fail("manifest_version should be 0.3")
    version = manifest.get("version")
    if not version or version != package.get("version"):
        fail(f"manifest version {version!r} and package.json version {package.get('version')!r} differ")
    if package.get("type") != "module":
        fail('package.json must say "type": "module"')
    entry = manifest.get("server", {}).get("entry_point")
    if entry not in files:
        fail(f"entry point {entry!r} is not in the package")
    if manifest.get("icon") not in files:
        fail(f"icon {manifest.get('icon')!r} is not in the package")
    if "server/tools.json" not in files:
        fail("server/tools.json is missing: run tools/gen-tools.mts")
    tools = json.loads(files["server/tools.json"]).get("tools", [])
    if [t["name"] for t in manifest.get("tools", [])] != [t["name"] for t in tools]:
        fail("manifest.json tools and server/tools.json differ: run tools/gen-tools.mts")
    return manifest["name"], version


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="folder for the .mcpb (default: dist/)")
    ap.add_argument("--allow-dirty", action="store_true", help="pack HEAD even though the working tree has changes")
    args = ap.parse_args()

    if os.path.realpath(git("rev-parse", "--show-toplevel")) != os.path.realpath(ROOT):
        fail(f"{ROOT} is not the top of a git checkout")
    dirty = git("status", "--porcelain", "--untracked-files=normal")
    if dirty:
        if not args.allow_dirty:
            fail(
                "the working tree has uncommitted or untracked changes; commit them first "
                "(the .mcpb is built from HEAD), or pass --allow-dirty to pack HEAD without them:\n" + dirty
            )
        print("pack: the working tree has changes; packing HEAD without them", file=sys.stderr)

    commit = git("rev-parse", "HEAD")
    tag = subprocess.run(["git", "-C", ROOT, "describe", "--tags", "--exact-match", "HEAD"], capture_output=True, text=True).stdout.strip()
    files = committed_files()
    name, version = check(files)
    order = TOP_FILES + sorted(p for p in files if p.startswith(SERVER_DIR + "/"))

    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, f"{name}-{version}.mcpb")
    tmp = target + ".tmp"
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in order:
            info = zipfile.ZipInfo(rel, date_time=STAMP)
            info.create_system = 3  # Unix, so the permissions below are read
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[rel], compresslevel=9)
    os.replace(tmp, target)

    with open(target, "rb") as f:
        data = f.read()
    print(f"{target}")
    print(f"  commit  {commit}{f' ({tag})' if tag else ''}")
    print(f"  size    {len(data):,} bytes")
    print(f"  sha256  {hashlib.sha256(data).hexdigest()}")
    for rel in order:
        print(f"  {rel}")


if __name__ == "__main__":
    main()
