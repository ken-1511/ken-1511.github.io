# Multifamily Student Housing — parametric reconstruction study

An offline, static Three.js viewer for a parametric reconstruction study of a
seven-storey multifamily student housing building. It is **not** an as-built
model, and the interface is built so a reader can tell which parts are supported
by evidence and which are not, without asking.

## The four states

Every piece of geometry declares one:

| State | Means |
|---|---|
| `source-verified` | Traced to accepted plan evidence, with a source link. |
| `derived` | Computed from a verified parent by a stated, checkable rule. |
| `designer-default` | A reversible placeholder. Carries no claim. |
| `unresolved` | Building information we do not have. Shown as a gap, not a guess. |

A scope containing more than one state reports **mixed** — the roll-up never
promotes to the strongest member. `validateClaim()` throws at load time if
anything claims `source-verified` without a source link.

## Addresses and routes

Components carry a stable dotted address, and the route *is* the address:

```
building-a.floor-04.unit-0401.kitchen.base-03
#/building-a/floor-04/unit-0401
```

IDs come from the manifests. Nothing invents one at render time.

## What the source material establishes, and what it does not

The model is derived from a real construction set. That set is **a unit plan
series** — individual dwelling types, dimensioned. It contains **no floor
plates**: no level plans, no key plans, no core or corridor layout, no unit mix
schedule, no stacking diagram.

So the two halves of this model carry very different weight, and the interface
says which is which everywhere it shows them:

| | Basis | State |
|---|---|---|
| Unit type footprints and room inventories | Measured off the unit sheets | Real, but the sheets are withheld, so they publish with no source link |
| Seven levels, split 1–2 against 3–7 | Stated twice in the set's own detail references | Established |
| Level 1 taller than level 2 | Stated ceiling heights, 10'-0" against 9'-0" | Established |
| Which unit types occur on levels 1, 4, 5 and 7 | Unit tags carry their level | Established |
| Floor-to-floor heights, level elevations | Computed from stated ceiling heights | `derived` |
| **Every plate outline, corridor, core position, unit count and unit position** | **Nothing in the set** | **`unresolved`** |

The one dimensional datum that repeats across every unit sheet is a **23'-4"
unit depth**. The plates are built from it — two unit bands either side of a
code-minimum corridor — and that is a study arrangement, not a drawing.

## Scopes

Rooms are reusable parametric modules, levels compose rooms, and the building
composes levels. A unit *type* is authored once; a *floor-plan variant* places
types on a plate; a level is assigned a variant.

| Route | Scope |
|---|---|
| `#/building-a` | The whole building: seven levels, fifty-one units. |
| `#/building-a/floor-04` | One level. |
| `#/building-a/floor-04/unit-0403` | One unit. |
| `#/building-a/floor-04/commons-04` | That level's plate, corridor and shared rooms. |
| `#/building-a/floor-04/core-04` | That level's stairs, lift and shafts. |
| `#/building-a/floor-04/unit-0403/kitchen/base-03` | One component. |

A unit's address is its level plus its index in the variant, so re-laying-out a
plate moves geometry and renames nothing.

### Levels and variants

| Level | Role | Variant | Units | Plate | Basis |
|---|---|---|---|---|---|
| 01 | Entry | `variant-entry` | 1 | 1634 m², widest | Ceiling height and podium are stated; the programme is assumed |
| 02 | Podium, mixed | `variant-podium-mixed` | 6 | 735 m², terrace void | Distinguished from above by the set; contents unknown |
| 03 | Residential | `variant-residential-a` | 9 | 821 m² | **Repeat** — nothing is tagged on this level |
| 04 | Residential | `variant-residential-b` | 9 | 873 m² | Widest set of unit tags, including both mobility types |
| 05 | Residential | `variant-residential-a` | 9 | 821 m² | **Repeat** — one tag falls here |
| 06 | Residential | `variant-residential-a` | 9 | 821 m² | **Repeat** — nothing is tagged on this level |
| 07 | Residential | `variant-residential-c` | 8 | 802 m², set back | One tag falls here |

Levels sharing a variant are marked **repeated** in the interface, and say which
levels they share with. That is the honest reading: nothing establishes that
those levels are identical, and nothing establishes that they differ.

`floors/floor-02.json` and `rooms/room-*.json` are the earlier hand-authored
single-floor path. They are superseded by `building.json` and load only through
the fallback branch in `app.js`.

## Display modes

None of these creates, destroys, or re-parents geometry, and none changes a truth
state. The object count is identical with each of them on and off.

| Control | What it does |
|---|---|
| **Camera** — 3D study, plan, section | Perspective or orthographic framing. |
| **Shell** — solid, ghost, cutaway, off | How walls and openings are treated. Cutaway drops the walls the camera is outside of, re-resolved as you orbit; it means nothing in a plan, which is already a cut. |
| **Section plane** | A clip across the scene on any axis, positioned across the model's own extent. Removes fragments at draw time. |
| **Explode** | Separates the levels vertically. A display offset, not an elevation — the lowest level stays on the ground plane. |
| **Layers** | One toggle per layer the build actually contains, discovered from the part specs rather than hard-coded. |
| **Levels** | Show or hide any level. A hidden level keeps its addresses and its components. |
| **Truth overlay** | Recolours every surface by evidence state. A material swap only. |

## Progressive loading

By default only the level in view is built. Every other level is drawn as **its
own plate outline, extruded to its own floor-to-floor height** — not a generic
box, because the plates differ and a repeated box would hide exactly the thing
that makes the building a building.

|  | Components | Massing blocks |
|---|---|---|
| One level built | 19–114, depending on the level | 6 |
| All seven levels | 812 | 0 |

Selecting a level builds it and lets the one it replaced fall back to massing.
Clicking a massing block does the same thing, because that is the only thing a
block can mean.

A massing block is **not a component**: it has no address, it is not in the index,
and it is not in the object count — otherwise the object count would measure the
display setting rather than the model. Blocks are reported separately in the
status bar and take the `designer-default` colour under the truth overlay, which
is exactly what they are.

## Selection

One address is the entire selection state. The level, the room, the component,
every label, the camera target and the floor-composition panel are all *derived*
from it by `resolveScope`, in one place, once per change.

This is not tidiness. Before it, each panel worked the selection out for itself
from whichever variable was nearest, and they disagreed — a tooltip could name
Level 07 while the inspector named Level 06. `assertCoherent` now reads the
strings actually in the DOM back and reports any that name a different level
from the selection; it runs on every change and caught two real defects on its
first browser run.

The full-detail switch builds every level at once. It exists so the cost and the
saving can be compared rather than asserted.

## Dimensions

Pinned, not parametric. Every figure is a standard millwork or framing dimension
in inches, chosen as a mutually compatible set. Sliders were removed this pass and
return later as viewing adjustments; `RoomViewer.setParam` is still there for them.

## Accessibility

Two documents govern, and they are not interchangeable:

- **2010 ADA Standards** — knee and toe clearance (306), work surface height
  (606.3), faucets (606.4 / 309.4), exposed pipes (606.5), clear floor space
  (305.3), kitchen aisle (804.2.1).
- **UFAS 4.34.6.5** — kitchen sinks in accessible dwelling units. This is where
  the 6½ in bowl depth and the 19 in knee depth come from. **The 2010 ADA
  Standards contain no sink-depth requirement**; section 606 ends at 606.5.

`workSurfaceHeight` is the **finished top surface** — the plane 606.3 measures
("rim or counter, whichever is higher"). The counter slab sits inside that figure,
not on top of it.

Margins are narrow here by design and are reported as signed inches rather than a
pass/fail, because a half-inch pass and a six-inch pass are not the same thing:

| Check | Built | Governing | Margin |
|---|---|---|---|
| Work surface height | 34.00 in | 34 in max | 0.00 in |
| Sink bowl depth | 6.50 in | 6.5 in max | 0.00 in |
| Knee clearance under bowl | 27.50 in | 27 in min | **+0.50 in** |
| Knee clearance width | 36.00 in | 30 in min | +6.00 in |
| Knee clearance depth | 19.00 in | 19 in min | 0.00 in |
| Toe clearance depth | 17.00 in | 17 in min | 0.00 in |
| Aisle to opposing counter | 46.68 in | 40 in min | +6.68 in |

Anything under an inch of slack is flagged in the readout. The readout measures
the built geometry, not the input value.

Clearance envelopes render as dashed guides, are `derived`, carry their citation,
and are excluded from the solid object count.

## Source references

**This build publishes no evidence raster and no drawing-set numbering.**

An accepted plan anchor exists for the kitchen scope in the private record, but the
evidence page carries client drawing identity and is withheld from publication. An
unshown source is not a source, so no scope claims `source-verified` — the unit
type reads `unresolved`, and so does every instance of it. `validateClaim()`
enforces this: a `source-verified` claim without a source link throws at load.

The evidence-state legend still lists all four states even though nothing in this
build occupies `source-verified`. States with no occurrences are marked *none in
this build* rather than left to inference — a colour matching nothing on screen
is otherwise ambiguous between "absent" and "broken".

## Running it

Static files, no build step, no CDN. Three.js is vendored at `vendor/three/`.

```
python3 -m http.server 4180
```

The canvas is full bleed on load. **Press `E`** for the study panels — rooms,
model tree, display rail, inspector.

## Verification

```
sh tests/run-all.sh
```

Runs without a GPU, a browser, or a network. `tests/three-headless.js`
substitutes the WebGLRenderer and nothing else, so `verify-viewer.js` drives the
real class over the real spec: the detail policy, address stability across
rebuilds, that a measured dimension is unchanged by an explode six levels up,
the cutaway sign test, and that no display mode moves the object count.

Shading, real draw calls, real frame timing, and anything depending on layout
need a browser and are not covered here.

## Layout

```
app.js                 thin bootstrap: router + manifest -> RoomViewer + panels
src/ids.js             ID grammar, parse/join/ancestors/scope
src/truth.js           the four states, rollup(), validateClaim()
src/ada.js             accessibility dimensions with citations
src/materials.js       parallel finish / truth / massing material sets
src/generators.js      declarative spec -> geometry
src/types.js           unit types and instantiation
src/building.js        levels + variants -> placed rooms, plates, per-level records
src/selection.js       one resolved scope; every label derives from it
src/display.js         explode, clip, cutaway and detail arithmetic, renderer-free
src/room-viewer.js     reusable RoomViewer: renderer, cameras, picking, composition index
src/router.js          hash routes over component addresses
building.json          the building: seven levels, each assigned a variant
levels/variant-*.json  floor-plan variants: plate, corridor, core, common, units
types/unit-*.json      six authored unit types, measured off the unit sheets
tools/build_model.py   emits the types, the variants and the building spec
rooms/manifest.json    registry: what to load, display names, layer labels
rooms/room-*.json      hand-authored room definitions (single-floor path)
floors/floor-02.json   hand-authored floor registry (superseded by building.json)
tests/                 headless checks; run-all.sh runs them
```
