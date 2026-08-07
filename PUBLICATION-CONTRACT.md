# Publication contract

What may reach a public remote. Enforced by `tools/check_publishable.py`,
wired to `pre-push`. Fails closed: anything it cannot evaluate, it denies.

Standard-library Python, no dependencies — the project has no build step and a
gate that needs a package install is a gate that gets skipped.

This contract governs **identifiability**. It does not establish **standing** —
whether you hold the right to publish the material at all is a separate
agreement with the drawing owner, and C5 is the only place the two touch.

## Why this exists

On 2026-08-05 a commit published a client drawing raster with its title block
legible. The scheme in place at the time substituted *published strings*. It had
no concept of pixels, and no concept of history. Both gaps are now checks.

This document names no client, project, sheet, or commit. It is committed to a
public repository and is therefore subject to the contract it describes — an
earlier draft quoted the live identifiers to illustrate the rules, and C2 denied
it. The worked examples live in `PROVENANCE.md`, which is never published.

Two facts that shape every rule below:

1. **Removal is not unpublication.** Deleting a blob from the tip tree leaves it
   fetchable by SHA on GitHub indefinitely. The gate therefore runs against every
   blob introduced in the push range, not against the resulting tree. A push that
   adds and then removes a denied blob is still denied.
2. **A load-time check is too late.** `validateClaim()` throws in the browser,
   which is after the bytes are on a CDN. This gate throws before the objects
   leave the machine.

## The checks

### C0 — Fail closed
No terms file → abort, exit 2. Unreadable blob → deny. Unknown image format →
deny. Checker throws → non-zero. Absence of the secret list never means "clean";
it means the operator is not equipped to make this decision.

### C1 — Denied paths
`PROVENANCE.md`, `BRIEF*.md`, `.publication/**`, anything matching
`*.secret.*`. Denied by path, and — because a rename defeats a path rule —
also by content signature: any blob whose first 4 KiB matches a known
denied-document fingerprint is denied under whatever name it carries.

### C2 — Term sweep
Terms load from `.publication/terms.txt` (one per line, `#` comments), plus any
backticked token and any ALL-CAPS phrase parsed out of `PROVENANCE.md`.

Both sources are themselves denied by C1. `terms.txt` is gitignored and
uncommitted by design — a fresh clone aborts at C0 until the operator supplies
it. That is intended friction.

Two term forms:

- `ACRONYM` — exact, case-insensitive, word-bounded.
- `~two words` — partial. Matches any substring occurrence.

Partials exist because the failure mode is not the full identifier, it is the
recognisable remnant. Dropping the client prefix from a sheet title leaves a
building-type phrase that still sits next to real plan geometry and still names
the project to anyone who has seen the sheet. Substitution is not
de-identification when the remainder is unique. **Project names are terms.
Place names are terms.**

Paths are swept as well as contents. An asset filename built from a sheet
reference leaks in the URL whether or not anything links to it.

### C3 — Raster manifest
Every image blob must appear in `.publication/rasters.json`, keyed by the
sha256 of the bytes being published:

```json
{
  "<sha256 of published file>": {
    "source_digest": "<sha256 of the original, unredacted>",
    "crop":          "x,y,w,h in source pixels",
    "approved_by":   "ken",
    "approved_at":   "2026-08-06",
    "note":          "plan region only; title block and revision block outside crop"
  }
}
```

Keying on the *output* digest is the point: approving an image approves those
exact bytes. Re-cropping invalidates the entry and forces re-approval. An image
whose digest equals any recorded `source_digest` is denied — that is the
original shipping under an approved name.

No entry → deny. There is no default-allow for images.

### C4 — Image metadata
PNG: no `tEXt`, `iTXt`, `zTXt`, `eXIf` chunks. JPEG: no `APP1` (EXIF/XMP),
`APP13` (Photoshop IRB), `APP14`, or `COM`.

Drawing-set exports routinely carry the original filename, the CAD operator, and
the sheet title in metadata that survives cropping. A visually clean crop is not
a clean file.

### C5 — Claim backing
Any claim at truth state `source-verified` must be backed one of two ways.

**A public standard — `citation`.** Nobody owns a code section, so no license is
required and no source ref is required: the citation *is* the source. It must
resolve to a numbered clause a reader can look up — `2010 ADA 606.3`,
`UFAS 4.34.6.5`, `CBC 11B-804.2`, `IBC 1006.2`. Prose is rejected. The pattern is
the whole control; an unvalidated `citation` field is just somewhere to type your
way past the gate.

**Licensed material — `license` + `source`.** For anything someone else owns. The
license must resolve to a live, unexpired entry in `.publication/licenses.json`.

Neither → denied.

This is where identifiability meets standing, and the two routes are not
equivalent. Code-anchored geometry is verifiable by anyone, permanently, with no
agreement in place — it is the stronger claim, not the fallback. Licensed
material depends on a relationship that can lapse, which is why the entry carries
an expiry.

Detail that can be backed neither way is not thereby worthless; it belongs at
`designer-default` with a note saying what it is. A working figure taken from
study, labelled as a working figure, is an honest claim. The four-state model
exists so that the geometry can stay while the certainty is stated accurately.

### C6 — Range, not tree
C1–C5 run against every blob introduced by every commit in `<base>..<head>`.
This is the check that would have caught the original exposure — the tip tree
was clean within an hour, and the bytes stayed fetchable regardless.

### C7 — Public remotes are strict
If the push target resolves to a public repository, all checks are errors. On a
private remote, C3–C5 degrade to warnings; C1 and C2 stay errors, because a
private repo can be flipped public in one click.

## Running it

```
python3 tools/check_publishable.py --range origin/main..HEAD --remote origin
python3 tools/check_publishable.py --ref HEAD          # tree only, weaker
```

Exit codes: `0` pass · `1` denied · `2` cannot evaluate (treat as denied).

Install the hook:

```
git config core.hooksPath .githooks
```

## For agents

Do not add terms to `terms.txt` to make a check pass. Do not add a
`rasters.json` entry for an image you produced without it being looked at. Both
are the operator's decisions. If the gate denies your push, report the denial and
stop — a denial is a finding, not an obstacle.

`--no-verify` exists and is not yours to use.
