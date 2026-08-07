#!/usr/bin/env python3
"""Publication gate. See PUBLICATION-CONTRACT.md.

Denies on anything it cannot evaluate.
Exit 0 pass, 1 denied, 2 cannot evaluate (treat as denied).

Standard library only, by design: a gate that needs a package install is a gate
that gets skipped.
"""

import datetime
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import zlib  # noqa: F401  (kept: PNG CRC verification hook)

# ------------------------------------------------------------------ arguments

argv = sys.argv[1:]


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


RANGE = opt("--range")
REF = opt("--ref", "HEAD")
REMOTE = opt("--remote")


def git(*a, binary=False):
    out = subprocess.run(
        ["git", *a], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True
    ).stdout
    return out if binary else out.decode("utf-8", "replace")


try:
    ROOT = git("rev-parse", "--show-toplevel").strip()
except Exception as e:
    print(f"\n  CANNOT EVALUATE — not a git repository: {e}\n", file=sys.stderr)
    sys.exit(2)

P = lambda p: os.path.join(ROOT, p)  # noqa: E731

findings = []
deny = lambda c, p, d: findings.append(("deny", c, p, d))  # noqa: E731
warn = lambda c, p, d: findings.append(("warn", c, p, d))  # noqa: E731


def abort(msg):
    print(f"\n  CANNOT EVALUATE — {msg}", file=sys.stderr)
    print("  Fail closed: treat this as denied.\n", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- strictness
# A private remote still gets C1/C2 as errors; it is one click from public.

strict = True
if REMOTE:
    try:
        url = git("remote", "get-url", REMOTE).strip()
        m = re.search(r"github\.com[/:]([^/]+)/(.+?)(?:\.git)?$", url)
        if m:
            info = subprocess.run(
                ["gh", "api", f"repos/{m.group(1)}/{m.group(2)}"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
            ).stdout
            strict = json.loads(info).get("private") is not True
    except Exception:
        strict = True  # visibility unknown -> assume public


# ---------------------------------------------------------------- C0 / terms

TERMS_FILE = P(".publication/terms.txt")
PROVENANCE = P("PROVENANCE.md")

if not os.path.exists(TERMS_FILE):
    abort(
        """no .publication/terms.txt — this file is gitignored by design and must be
  supplied locally. Without it the sweep has nothing to sweep for, and a silent
  pass would be worse than a stop."""
    )

terms = []          # list of (compiled_regex, label)
_seen_terms = set()


def add_term(raw):
    t = raw.strip()
    if not t or t.startswith("#"):
        return
    if t.startswith("~"):
        body = t[1:].strip()
        if len(body) < 3 or ("~", body.lower()) in _seen_terms:
            return
        _seen_terms.add(("~", body.lower()))
        terms.append((re.compile(re.escape(body), re.I), "~" + body))
    else:
        if len(t) < 3 or ("=", t.lower()) in _seen_terms:
            return
        _seen_terms.add(("=", t.lower()))
        terms.append(
            (re.compile(r"(^|[^A-Za-z0-9])" + re.escape(t) + r"([^A-Za-z0-9]|$)", re.I), t)
        )


with open(TERMS_FILE, encoding="utf-8") as fh:
    for line in fh:
        add_term(line)

if not terms:
    abort("terms list resolved to zero entries")

# PROVENANCE.md is NOT harvested for enforcement. It is a two-column mapping, and
# scraping it denies both columns — including the de-identified replacements that
# exist precisely to be published. It also yields generic acronyms that match
# vendored libraries. `--suggest` reports candidates for a human to triage into
# terms.txt; it never adds them.
if "--suggest" in argv and os.path.exists(PROVENANCE):
    prov = open(PROVENANCE, encoding="utf-8", errors="replace").read()
    known = {label.lstrip("~").lower() for _, label in terms}
    cand = set()
    for m in re.finditer(r"`([^`\n]{3,60})`", prov):
        cand.add(m.group(1).strip())
    for m in re.finditer(r"\b([A-Z][A-Z0-9]{3,}(?:[ -][A-Z0-9]{2,}){1,5})\b", prov):
        cand.add(m.group(1).strip())
    new = sorted(c for c in cand if c.lower() not in known)
    print("\n  candidate terms in PROVENANCE.md not present in terms.txt:")
    print("  (left-hand identifiers only — do not add the replacements)\n")
    for c in new:
        print(f"    {c}")
    print(f"\n  {len(new)} candidates. Triage by hand.\n")
    sys.exit(0)


# ---------------------------------------------------------------- C1 paths

DENIED_PATHS = [
    re.compile(r"^PROVENANCE\.md$", re.I),
    re.compile(r"(^|/)BRIEF[^/]*\.md$", re.I),
    re.compile(r"^\.publication/"),
    re.compile(r"\.secret\.", re.I),
    re.compile(r"(^|/)node_modules/"),
]

# A rename defeats a path rule; these fingerprints catch the content itself.
#
# Patterns are assembled from fragments so that this file never contains a
# contiguous copy of any of them. A fingerprint list written the obvious way
# matches its own source and denies the gate itself — labels count as content.
def _fp(label, *frags):
    return (label, re.compile("".join(frags), re.I))


DENIED_FINGERPRINTS = [
    _fp("provenance mapping document", "opaque published ", "refs? back to"),
    _fp("brief mapping document", "de-", "identification (mapping|table)"),
]


# ---------------------------------------------------------------- manifests

def read_json(rel, default):
    f = P(rel)
    if not os.path.exists(f):
        return default
    try:
        return json.load(open(f, encoding="utf-8"))
    except Exception as e:
        abort(f"{rel} is not valid JSON: {e}")


rasters = read_json(".publication/rasters.json", {})
licenses = read_json(".publication/licenses.json", {})
source_digests = {
    v.get("source_digest") for v in rasters.values()
    if isinstance(v, dict) and v.get("source_digest")
}


# ---------------------------------------------------------------- C4 metadata

PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_BAD = {b"tEXt", b"iTXt", b"zTXt", b"eXIf"}


def png_metadata(buf):
    bad, off, n = [], 8, len(buf)
    while off + 8 <= n:
        (length,) = struct.unpack(">I", buf[off:off + 4])
        ctype = buf[off + 4:off + 8]
        if ctype in PNG_BAD:
            bad.append(ctype.decode("ascii"))
        if ctype == b"IEND" or length > n:
            break
        off += 12 + length
    return bad


JPEG_BAD = {
    0xE1: "APP1 (EXIF/XMP)", 0xED: "APP13 (Photoshop IRB)",
    0xEE: "APP14", 0xFE: "COM",
}


def jpeg_metadata(buf):
    bad, off, n = [], 2, len(buf)
    while off + 4 <= n:
        if buf[off] != 0xFF:
            break
        marker = buf[off + 1]
        if marker in (0xDA, 0xD9):      # start of scan / end of image
            break
        (length,) = struct.unpack(">H", buf[off + 2:off + 4])
        if marker in JPEG_BAD:
            bad.append(JPEG_BAD[marker])
        off += 2 + length
    return bad


# C5 public-standard citations. Nobody owns a code section, so these need no
# license — but they must resolve to a numbered clause a reader can look up.
# Freeform prose is rejected: an unvalidated "citation" field is just a way to
# type your way past the gate.
STANDARD_RE = re.compile(
    r"""(?ix)
    \b(
        (?:\d{4}\s+)? ADA (?:\s+Standards)?     |   # 2010 ADA 606.3
        UFAS                                    |   # UFAS 4.34.6.5
        CBC (?:\s+11B)?                         |   # CBC 11B-804.2
        ANSI\s+A117\.1                          |
        I(?:BC|RC|ECC|PC|MC)                    |   # IBC 1006.2
        NFPA                                    |
        ASTM                                    |
        ASHRAE
    )
    [\s§-]* [A-Z]?\d+(?:[.\-]\d+)*         \b  # a numbered clause (ASTM E119)
    """
)
STANDARD_HINT = '"2010 ADA 606.3", "UFAS 4.34.6.5", "CBC 11B-804.2", "IBC 1006.2"'

IMAGE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|tiff?|bmp|avif|heic)$", re.I)

# Binary types that carry no client content and are cleared by magic bytes.
# Anything not on this list is denied under C0 rather than guessed at.
BINARY_ALLOW = [
    (b"\x00\x01\x00\x00", "TrueType font"),
    (b"true", "TrueType font"),
    (b"ttcf", "TrueType collection"),
    (b"OTTO", "OpenType font"),
    (b"wOFF", "WOFF font"),
    (b"wOF2", "WOFF2 font"),
]


def binary_allowed(buf):
    for sig, label in BINARY_ALLOW:
        if buf[: len(sig)] == sig:
            return label
    return None


# ---------------------------------------------------------------- claims

def walk_claims(node, fn, at="$"):
    if isinstance(node, list):
        for i, v in enumerate(node):
            walk_claims(v, fn, f"{at}[{i}]")
        return
    if not isinstance(node, dict):
        return
    state = node.get("truth", node.get("state", node.get("truthState")))
    if isinstance(state, str) and re.search(r"source[-_ ]?verified", state, re.I):
        fn(node, at)
    for k, v in node.items():
        walk_claims(v, fn, f"{at}.{k}")


# ---------------------------------------------------------------- per-blob

seen = set()


def check_blob(sha, path, origin):
    key = (sha, path)
    if key in seen:
        return
    seen.add(key)
    where = f"{path}  ({origin})" if origin else path

    for rx in DENIED_PATHS:                                   # C1 path
        if rx.search(path):
            return deny("C1", where, f"denied path pattern {rx.pattern}")

    try:
        buf = git("cat-file", "blob", sha, binary=True)
    except Exception as e:
        return deny("C0", where, f"unreadable blob {sha[:8]}: {e}")

    digest = hashlib.sha256(buf).hexdigest()
    is_binary = b"\x00" in buf[:8000]

    for rx, label in terms:                                   # C2 path text
        if rx.search(path):
            deny("C2", where, f'denied term "{label}" in the path itself')

    if IMAGE_EXT.search(path) or buf[:8] == PNG_SIG:
        entry = rasters.get(digest)                           # C3 manifest
        if not entry:
            (deny if strict else warn)(
                "C3", where,
                f"image not in .publication/rasters.json (sha256 {digest[:16]}…) "
                "— no default-allow for images",
            )
        elif not entry.get("approved_by") or not entry.get("approved_at"):
            deny("C3", where, "manifest entry lacks approved_by / approved_at")
        if digest in source_digests:
            deny("C3", where,
                 "this is a recorded UNREDACTED source, shipping under an approved name")

        bad = []                                              # C4 metadata
        if buf[:8] == PNG_SIG:
            bad = png_metadata(buf)
        elif buf[:2] == b"\xff\xd8":
            bad = jpeg_metadata(buf)
        elif strict:
            deny("C4", where, "image format not parseable for metadata — cannot clear it")
        if bad:
            deny("C4", where, "carries metadata chunks: " + ", ".join(sorted(set(bad))))
        return

    if is_binary:
        if binary_allowed(buf) is None and strict:
            deny("C0", where, "binary blob of unknown type — cannot evaluate, so denied")
        return

    text = buf.decode("utf-8", "replace")

    # C1 fingerprint. Only for prose-sized documents: the denied files are
    # multi-page write-ups, and a config comment that quotes one of these phrases
    # in order to explain the rule is not the document. Config that trips this
    # would otherwise train people to bypass the gate.
    if len(buf) > 1500 and not os.path.basename(path).startswith("."):
        for label, rx in DENIED_FINGERPRINTS:
            if rx.search(text[:4096]):
                return deny("C1", where,
                            f"content fingerprint: {label} (renamed does not mean allowed)")

    for rx, label in terms:                                    # C2 contents
        m = rx.search(text)
        if m:
            line = text[: m.start()].count("\n") + 1
            deny("C2", f"{where}:{line}", f'denied term "{label}"')

    if path.lower().endswith(".json"):                         # C5 licensing
        try:
            doc = json.loads(text)
        except Exception:
            return

        def check_claim(claim, at):
            spot = f"{where} {at}"
            cite = claim.get("citation")
            lic_ref = claim.get("license")

            # A public standard needs no license — nobody owns a code section —
            # but it must be a resolvable reference, not prose. The pattern is the
            # whole control: without it "citation" becomes a field you type
            # anything into to get past the gate.
            if cite is not None:
                if not isinstance(cite, str) or not STANDARD_RE.search(cite):
                    return deny(
                        "C5", spot,
                        f'citation "{cite}" does not resolve to a recognised public '
                        f"standard — expected e.g. {STANDARD_HINT}",
                    )
                return  # verifiable by anyone; no license, no source ref required

            if lic_ref is None:
                return (deny if strict else warn)(
                    "C5", spot,
                    "source-verified with neither a citation nor a license ref — the "
                    "project cannot assert provenance it has no right to assert",
                )
            lic = licenses.get(lic_ref)
            if not lic:
                return deny("C5", spot,
                            f'license "{lic_ref}" not in .publication/licenses.json')
            exp = lic.get("expires")
            if exp and exp < datetime.date.today().isoformat():
                deny("C5", spot, f'license "{lic_ref}" expired {exp}')
            if claim.get("source") is None:
                deny("C5", spot, "source-verified without a source ref")

        walk_claims(doc, check_claim)


# ---------------------------------------------------------------- drive

def blobs_in_tree(ref):
    out = []
    for line in git("ls-tree", "-r", ref).split("\n"):
        m = re.match(r"^\d+ blob ([0-9a-f]+)\t(.+)$", line)
        if m:
            out.append((m.group(1), m.group(2), None))
    return out


def blobs_in_range(rng):
    # Passed through to rev-list verbatim so callers can express "everything the
    # remote does not have" as `<sha> --not --remotes=<remote>`. A new branch has
    # no `<remote_sha>..` to anchor to, and `<root>^` does not resolve.
    out = []
    for c in [x for x in git("rev-list", *rng.split()).split("\n") if x]:
        raw = git("diff-tree", "-r", "--no-commit-id", "--diff-filter=AM", c)
        for line in raw.split("\n"):
            m = re.match(r"^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AM]\t(.+)$", line)
            if m and set(m.group(1)) != {"0"}:
                out.append((m.group(1), m.group(2), f"introduced by {c[:8]}"))
    return out


try:
    blobs = blobs_in_range(RANGE) if RANGE else blobs_in_tree(REF)
except Exception as e:
    abort(f"could not enumerate blobs: {e}")

if RANGE and not blobs:
    print("  nothing to check — range is empty")
    sys.exit(0)

for sha, path, origin in blobs:
    check_blob(sha, path, origin)


# ---------------------------------------------------------------- report

denies = [f for f in findings if f[0] == "deny"]
warns = [f for f in findings if f[0] == "warn"]
scope = f"range {RANGE}" if RANGE else f"tree {REF}"
mode = "STRICT (public target)" if strict else "relaxed (private target)"

print(f"\n  publication gate — {scope}, {len(blobs)} blobs, {len(terms)} terms, {mode}")

for _, c, p, d in warns:
    print(f"  warn  {c}  {p}\n        {d}")

sys.stdout.flush()  # keep the header above the findings when stderr is a tty

if denies:
    s = "" if len(denies) == 1 else "s"
    print(f"\n  DENIED — {len(denies)} finding{s}\n", file=sys.stderr)
    for _, c, p, d in denies:
        print(f"  {c}  {p}\n      {d}\n", file=sys.stderr)
    print("  Removing these from HEAD is not enough if they are already in the range —",
          file=sys.stderr)
    print("  a blob introduced and then deleted stays fetchable by SHA. Rewrite or rebuild.\n",
          file=sys.stderr)
    sys.exit(1)

if warns:
    plural = "" if len(warns) == 1 else "s"
    print(f"  PASS ({len(warns)} warning{plural})\n")
else:
    print("  PASS\n")
sys.exit(0)
