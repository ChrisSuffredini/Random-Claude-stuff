"""Unpack every hltv-data*.tar.gz / hltv-data*.json.gz uploaded through GitHub
into data/raw/ (several uploads, e.g. one per laptop, merge cleanly).

    python3 model/unpack.py [path ...]
"""
import base64
import glob
import gzip
import json
import os
import sys
import tarfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")


def target(rel, archive):
    # each upload carries its own manifest.json; keep them side by side
    if rel == "raw/manifest.json":
        tag = os.path.basename(archive).split(".")[0]
        rel = f"raw/manifest.{tag}.json"
    return os.path.join(DATA, rel)


def main():
    srcs = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "hltv-data*.tar.gz")) +
                                  glob.glob(os.path.join(ROOT, "hltv-data*.json.gz")))
    if not srcs:
        sys.exit("no hltv-data*.tar.gz / hltv-data*.json.gz found")
    os.makedirs(DATA, exist_ok=True)
    for src in srcs:
        unpack(src)


def unpack(src):
    n = 0
    if src.endswith(".tar.gz"):
        with tarfile.open(src) as tf:
            for mem in tf.getmembers():
                # only plain files under raw/, no absolute paths or ..
                if not mem.isfile() or not mem.name.startswith("raw/") or ".." in mem.name.split("/"):
                    continue
                out = target(mem.name, src)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with tf.extractfile(mem) as f, open(out, "wb") as g:
                    g.write(f.read())
                n += 1
    else:
        bundle = json.loads(gzip.decompress(open(src, "rb").read()))
        for rel, b64 in bundle.items():
            if not rel.startswith("raw/") or ".." in rel.split("/"):
                continue
            out = target(rel, src)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as g:
                g.write(base64.b64decode(b64))
            n += 1
    print(f"{os.path.basename(src)}: unpacked {n} files into {os.path.join(DATA, 'raw')}")


if __name__ == "__main__":
    main()
