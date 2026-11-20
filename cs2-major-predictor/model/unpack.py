"""Unpack hltv-data.tar.gz (or hltv-data.json.gz) uploaded through GitHub into data/raw/.

    python3 model/unpack.py [path]
"""
import base64
import gzip
import json
import os
import sys
import tarfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src:
        for name in ("hltv-data.tar.gz", "hltv-data.json.gz"):
            if os.path.exists(os.path.join(ROOT, name)):
                src = os.path.join(ROOT, name)
                break
    if not src:
        sys.exit("no hltv-data.tar.gz / hltv-data.json.gz found")
    os.makedirs(DATA, exist_ok=True)
    n = 0
    if src.endswith(".tar.gz"):
        with tarfile.open(src) as tf:
            for mem in tf.getmembers():
                # only plain files under raw/, no absolute paths or ..
                if not mem.isfile() or not mem.name.startswith("raw/") or ".." in mem.name.split("/"):
                    continue
                out = os.path.join(DATA, mem.name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with tf.extractfile(mem) as f, open(out, "wb") as g:
                    g.write(f.read())
                n += 1
    else:
        bundle = json.loads(gzip.decompress(open(src, "rb").read()))
        for rel, b64 in bundle.items():
            if not rel.startswith("raw/") or ".." in rel.split("/"):
                continue
            out = os.path.join(DATA, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as g:
                g.write(base64.b64decode(b64))
            n += 1
    print(f"unpacked {n} files into {os.path.join(DATA, 'raw')}")


if __name__ == "__main__":
    main()
