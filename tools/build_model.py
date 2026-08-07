#!/usr/bin/env python3
"""
Emit the unit types and floor-plan variants the viewer consumes.

Why a generator rather than hand-authored JSON: a floor plate is a corridor with
units laid along it, and the x positions are a running sum. Hand-maintaining
those means every edit to one unit silently moves every unit after it. The
compact declarations at the bottom of this file are the thing a human edits; the
JSON is a build product and is committed so the site stays a no-build static
tree.

Nothing here carries source identity. The dimensions come from the local unit
plan sheets; which sheet, and what project they belong to, lives only in the
git-ignored inventory.

Truth states, applied consistently:

  designer-default  study geometry we chose — slabs, walls, room zones, corridor
  unresolved        something the set does not establish — every unit *position*,
                    every plate outline, the corridor itself, the core locations
  derived           computed from something stated, with the rule named

No part is source-verified. The set is withheld from publication, and an unshown
source is not a source.

    python3 tools/build_model.py
"""

import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FT = 0.3048
IN = 0.0254


def ft(feet, inches=0.0):
    """
    Feet and inches to metres, rounded to 0.1 mm.

    A negative measurement carries the sign through the inches too: ft(-7, 10.5)
    is minus seven foot ten and a half, not minus seven feet plus ten inches.
    Getting that wrong moves things by twice the inches and is invisible in the
    output, so it is handled here rather than at every call site.
    """
    sign = -1 if (feet < 0 or (feet == 0 and inches < 0)) else 1
    return round(sign * (abs(feet) * FT + abs(inches) * IN), 4)


# ---------------------------------------------------------------- geometry ---

def rect_zone(x0, z0, x1, z1):
    return {"x0": min(x0, x1), "z0": min(z0, z1), "x1": max(x0, x1), "z1": max(z0, z1)}


def zone_centre(z):
    return ((z["x0"] + z["x1"]) / 2, (z["z0"] + z["z1"]) / 2)


def zone_size(z):
    return (round(z["x1"] - z["x0"], 4), round(z["z1"] - z["z0"], 4))


# -------------------------------------------------------------- unit types ---

WALL_T = ft(0, 4.5)          # 4 1/2 in — the set states door jambs at 4 1/2 in
PART_T = ft(0, 4.5)
CEIL_TYPICAL = ft(9)
CEIL_LEVEL_1 = ft(10)

ROOM_KIND = {
    "living": "Living / dining",
    "dining": "Dining",
    "sleeping": "Sleeping",
    "bedroom": "Bedroom",
    "bedroom-accessible": "Accessible bedroom",
    "kitchen": "Kitchen",
    "bath": "Bath",
    "pantry": "Pantry",
    "lobby": "Lobby",
    "study": "Study lounge",
    "laundry": "Laundry",
    "mail": "Mail",
    "bike": "Bike store",
    "trash": "Trash",
    "mechanical": "Mechanical",
    "corridor": "Corridor",
    "stair": "Stair",
    "elevator": "Elevator",
    "shaft": "Shaft",
}


def unit_type(type_id, name, short, width, depth, zones, *, cant=None,
              extra_parts=None, summary=None, ceiling=CEIL_TYPICAL,
              bedrooms=0, adaptable=False, mobility=False, notch=None):
    """
    One authored unit type in its own centred frame.

    `zones` are room rectangles in that frame. Each becomes a floor zone the
    plan view can read and a partition boundary in 3D. Room *extents* are a
    designer default; that these rooms exist, and the unit's overall dimensions,
    come off the sheet.
    """
    hw, hd = width / 2, depth / 2
    parts = []

    footprint = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    if cant:
        # A canted corner: replace the corner vertex with two, cut back by the
        # measured legs. B1 has one; it is the reason that type is not a box.
        cx, cz, leg_x, leg_z = cant
        footprint = [
            [-hw, -hd], [hw - (leg_x if cx > 0 else 0), -hd],
            [hw, -hd + leg_z] if cx > 0 else [hw, -hd],
            [hw, hd], [-hw, hd],
        ]
    if notch:
        nx0, nz0, nx1, nz1 = notch
        footprint = [
            [-hw, -hd], [hw, -hd], [hw, nz0], [nx0, nz0], [nx0, hd], [-hw, hd],
        ]

    parts.append({
        "type": "plate",
        "id": "slab",
        "name": "Unit slab",
        "truth": "designer-default",
        "layer": "structure",
        "geometry": {"polygon": footprint, "thickness": ft(0, 6), "y": 0},
        "note": "Study slab at the unit's measured overall extent.",
    })

    # Perimeter walls, one per footprint edge.
    for i in range(len(footprint)):
        ax, az = footprint[i]
        bx, bz = footprint[(i + 1) % len(footprint)]
        length = math.hypot(bx - ax, bz - az)
        if length < 0.05:
            continue
        angle = math.degrees(math.atan2(bx - ax, bz - az))
        parts.append({
            "type": "wall",
            "id": f"wall-{i + 1:02d}",
            "name": f"Perimeter wall {i + 1}",
            "truth": "designer-default",
            "layer": "shell",
            "geometry": {
                "x": round((ax + bx) / 2, 4), "z": round((az + bz) / 2, 4),
                "length": round(length, 4), "height": ceiling,
                "thickness": WALL_T, "rotation": round(-angle + 90, 3),
            },
        })

    for zid, kind, rect in zones:
        cx, cz = zone_centre(rect)
        w, d = zone_size(rect)
        parts.append({
            "type": "zone",
            # Prefixed so a room zone can never collide with an assembly that
            # occupies it — the B2 kitchen zone and the B2 kitchen casework run
            # are two different things at the same address otherwise.
            "id": f"zone-{zid}",
            "name": ROOM_KIND.get(kind, kind.title()),
            "roomType": kind,
            "truth": "designer-default",
            "layer": "zones",
            "geometry": {"x": round(cx, 4), "z": round(cz, 4), "width": w, "depth": d,
                         "y": ft(0, 0.5)},
            "note": "Room extents are a study arrangement. The set establishes that "
                    "this room exists in this unit type and the unit's overall "
                    "dimensions; it does not dimension the room within the unit.",
        })

    parts.extend(extra_parts or [])

    return {
        "schema": "parametric-study.unit-type.v1",
        "id": type_id,
        "name": name,
        "shortName": short,
        "unit": name,
        "truth": "unresolved",
        "container": "parametric study",
        "summary": summary,
        "source": None,
        "bedrooms": bedrooms,
        "accessibility": ("mobility" if mobility else "adaptable" if adaptable else None),
        "footprint": {
            "width": width, "depth": depth, "polygon": footprint,
            "truth": "designer-default",
            "note": "Overall dimensions are measured off the unit plan sheet. The "
                    "sheet itself is withheld, so no source link is published and "
                    "the type carries no verified claim.",
        },
        "massing": {
            "width": width, "height": ceiling, "depth": depth, "x": 0, "z": 0,
            "polygon": footprint,
            "truth": "designer-default",
            "note": "Coarse stand-in drawn when this unit's level is not loaded.",
        },
        "dimensions": None,
        "params": None,
        "displayNames": {},
        "parts": parts,
        "missing": [
            "A publishable source link for the unit plan",
            "Dimensioned room boundaries within the unit",
            "Where this unit sits on any floor plate",
        ],
    }


# ------------------------------------------------------------ floor plates ---

UNIT_DEPTH = ft(23, 4)          # recurs across S1, B1, B2, D1, D2 on the sheets
CORRIDOR_W = ft(6)
PLATE_DEPTH = round(UNIT_DEPTH * 2 + CORRIDOR_W, 4)

NORTH_C = round(UNIT_DEPTH / 2, 4)
CORRIDOR_C = round(UNIT_DEPTH + CORRIDOR_W / 2, 4)
SOUTH_C = round(UNIT_DEPTH + CORRIDOR_W + UNIT_DEPTH / 2, 4)


def run(types, sequence, x0, band_centre):
    """Lay a sequence of unit types along a band, returning placements."""
    out = []
    x = x0
    for entry in sequence:
        if isinstance(entry, tuple) and entry[0] == "gap":
            x += entry[1]
            continue
        type_id = entry
        width = types[type_id]["footprint"]["width"]
        out.append({
            "type": type_id,
            "transform": {"x": round(x + width / 2, 4), "z": band_centre, "rotation": 0},
        })
        x += width
    return out, round(x, 4)


def variant(vid, name, role, plate_polygon, north, south, *, ceiling, common,
            service, vertical, notes, evidence, corridor_extent):
    return {
        "schema": "parametric-study.floor-variant.v1",
        "id": vid,
        "name": name,
        "role": role,
        "truth": "unresolved",
        "evidence": evidence,
        "ceilingHeight": {"value": ceiling, "unit": "m", "truth": "derived",
                          "note": "Ceiling heights are stated for levels 1 and 2. "
                                  "Every other level takes the level 2 figure, which "
                                  "is a derivation, not a statement."},
        "plate": {
            "polygon": plate_polygon,
            "thickness": ft(0, 8),
            "truth": "unresolved",
            "note": "No floor plate is drawn anywhere in the available set. This "
                    "outline is a study arrangement built from the one dimension "
                    "that does repeat across every unit sheet — the 23'-4\" unit "
                    "depth — either side of a corridor.",
        },
        "corridor": {
            "id": "corridor",
            "x0": corridor_extent[0], "x1": corridor_extent[1],
            "z0": round(UNIT_DEPTH, 4), "z1": round(UNIT_DEPTH + CORRIDOR_W, 4),
            "truth": "unresolved",
            "note": "The set names corridors but locates none. Width is a code "
                    "minimum, not a measured figure.",
        },
        "units": north + south,
        "common": common,
        "service": service,
        "vertical": vertical,
        "notes": notes,
    }


def box_room(rid, kind, x0, z0, x1, z1, truth="unresolved", note=None):
    rect = rect_zone(x0, z0, x1, z1)
    cx, cz = zone_centre(rect)
    w, d = zone_size(rect)
    return {"id": rid, "roomType": kind, "name": ROOM_KIND.get(kind, kind.title()),
            "x": round(cx, 4), "z": round(cz, 4), "width": w, "depth": d,
            "truth": truth, "note": note}


# ------------------------------------------------------------------ build ---

def build():
    types = {}

    # --- S1 studio: 14'-11" x 23'-4" -------------------------------------
    w, d = ft(14, 11), ft(23, 4)
    hw, hd = w / 2, d / 2
    types["unit-s1"] = unit_type(
        "unit-s1", "Studio — Type S1", "Studio S1", w, d,
        [
            ("bath", "bath", rect_zone(-hw, -hd, -hw + ft(5, 6), -hd + ft(8, 0))),
            ("kitchen", "kitchen", rect_zone(-hw + ft(5, 6), -hd, hw, -hd + ft(8, 0))),
            ("sleeping", "sleeping", rect_zone(-hw, -hd + ft(8, 0), hw, hd)),
        ],
        bedrooms=0, adaptable=True,
        summary="Studio unit type. Overall dimensions are measured off the unit "
                "plan sheet; the arrangement of rooms within it is a study "
                "arrangement and carries no claim.")

    # --- B1 two-bedroom with a canted wing: 35'-8" x 23'-4" --------------
    w, d = ft(35, 8), ft(23, 4)
    hw, hd = w / 2, d / 2
    types["unit-b1"] = unit_type(
        "unit-b1", "Two bedroom — Type B1", "Unit B1", w, d,
        [
            ("kitchen", "kitchen", rect_zone(-hw, -hd, -hw + ft(11, 0), -hd + ft(9, 0))),
            ("dining", "dining", rect_zone(-hw, -hd + ft(9, 0), -hw + ft(11, 0), hd)),
            ("living", "living", rect_zone(-hw + ft(11, 0), -hd + ft(6, 0), -hw + ft(22, 0), hd)),
            ("bedroom-01", "bedroom", rect_zone(-hw + ft(22, 0), -hd, -hw + ft(29, 0), -hd + ft(12, 0))),
            ("bedroom-02", "bedroom", rect_zone(-hw + ft(29, 0), -hd, hw, -hd + ft(12, 0))),
            ("bath", "bath", rect_zone(-hw + ft(22, 0), -hd + ft(12, 0), hw, hd)),
        ],
        cant=(1, -1, ft(6, 0), ft(6, 0)),
        bedrooms=2, adaptable=True,
        summary="Two-bedroom unit type. The sheet shows a canted wing on one "
                "corner, so this type is not a rectangle; the cut is carried "
                "into the footprint rather than squared off.")

    # --- B2 two-bedroom: 33'-9 1/2" x 23'-4" -----------------------------
    # This is the type that carries the kitchen the ADA readout measures. Its
    # casework is lifted verbatim from the existing authored type so the
    # assembly, its addresses and its clearances are unchanged.
    existing = json.loads((ROOT / "types" / "unit-b2.json").read_text())
    by_id = {p["id"]: p for p in existing["parts"]}
    dx, dz = ft(-7, 10.5), ft(-6, 2)

    def shifted(part):
        p = json.loads(json.dumps(part))
        if p["type"] == "casework-run":
            p["anchor"] = {"x": round(p["anchor"]["x"] + dx, 5),
                           "z": round(p["anchor"]["z"] + dz, 5)}
        else:
            g = p["geometry"]
            g["x"] = round(g["x"] + dx, 5)
            g["z"] = round(g["z"] + dz, 5)
        return p

    w, d = ft(33, 9.5), ft(23, 4)
    hw, hd = w / 2, d / 2
    kitchen_parts = [shifted(by_id["kitchen"]), shifted(by_id["work-counter"]),
                     shifted(by_id["anchor-envelope"])]
    types["unit-b2"] = unit_type(
        "unit-b2", "Two bedroom — Type B2", "Unit B2", w, d,
        [
            ("kitchen", "kitchen", rect_zone(-hw, -hd, -hw + ft(16, 6), -hd + ft(9, 0))),
            ("living", "living", rect_zone(-hw, -hd + ft(9, 0), -hw + ft(16, 6), hd)),
            ("bedroom-01", "bedroom", rect_zone(-hw + ft(16, 6), -hd, -hw + ft(25, 3), -hd + ft(11, 6))),
            ("bedroom-02", "bedroom", rect_zone(-hw + ft(25, 3), -hd, hw, -hd + ft(11, 6))),
            ("bath", "bath", rect_zone(-hw + ft(16, 6), -hd + ft(11, 6), -hw + ft(25, 3), hd)),
            ("pantry", "pantry", rect_zone(-hw + ft(25, 3), -hd + ft(11, 6), hw, hd)),
        ],
        extra_parts=kitchen_parts,
        bedrooms=2, adaptable=True,
        summary=existing.get("summary"))

    # Keep the pinned millwork figures; replace the envelope row, which described
    # the kitchen room this type used to be rather than the unit it now is.
    dims = json.loads(json.dumps(existing.get("dimensions")))
    dims["fixed"] = [
        {"label": "Unit envelope",
         "governing": "33'-9 1/2\" × 23'-4\"",
         "metric": f"{w:.3f} × {d:.3f} m",
         "note": "Measured off the unit plan sheet. The 23'-4\" depth is the one "
                 "dimension that repeats across every unit type in the set."},
        {"label": "Kitchen zone",
         "governing": "15'-0\" × 9'-0\"",
         "metric": "4.572 × 2.743 m",
         "note": "Designer default. The sheet places a kitchen in this unit but "
                 "does not dimension the room around the casework."},
    ] + [row for row in dims["fixed"] if row["label"] != "Room envelope"]
    types["unit-b2"]["dimensions"] = dims

    # --- D1 four-bedroom bar: 49'-3" x 23'-4" ----------------------------
    w, d = ft(49, 3), ft(23, 4)
    hw, hd = w / 2, d / 2
    types["unit-d1"] = unit_type(
        "unit-d1", "Four bedroom — Type D1", "Unit D1", w, d,
        [
            ("bedroom-01", "bedroom", rect_zone(-hw, -hd, -hw + ft(10, 6), -hd + ft(12, 0))),
            ("bedroom-02", "bedroom", rect_zone(-hw + ft(10, 6), -hd, -hw + ft(21, 0), -hd + ft(12, 0))),
            ("bedroom-03", "bedroom", rect_zone(-hw + ft(21, 0), -hd, -hw + ft(31, 6), -hd + ft(12, 0))),
            ("bedroom-04", "bedroom", rect_zone(-hw + ft(31, 6), -hd, -hw + ft(42, 0), -hd + ft(12, 0))),
            ("bath-01", "bath", rect_zone(-hw, -hd + ft(12, 0), -hw + ft(10, 0), hd)),
            ("bath-02", "bath", rect_zone(-hw + ft(10, 0), -hd + ft(12, 0), -hw + ft(20, 0), hd)),
            ("living", "living", rect_zone(-hw + ft(20, 0), -hd + ft(12, 0), -hw + ft(35, 0), hd)),
            ("dining", "dining", rect_zone(-hw + ft(35, 0), -hd + ft(12, 0), hw, hd)),
            ("kitchen", "kitchen", rect_zone(-hw + ft(42, 0), -hd, hw, -hd + ft(12, 0))),
        ],
        bedrooms=4, adaptable=True,
        summary="Four-bedroom suite. The longest type in the set.")

    # --- D1.1 four-bedroom, notched: 48'-9" ------------------------------
    w, d = ft(48, 9), ft(23, 4)
    hw, hd = w / 2, d / 2
    types["unit-d1-1"] = unit_type(
        "unit-d1-1", "Four bedroom — Type D1.1", "Unit D1.1", w, d,
        [
            ("bedroom-01", "bedroom", rect_zone(-hw, -hd, -hw + ft(10, 6), -hd + ft(12, 0))),
            ("bedroom-02", "bedroom", rect_zone(-hw + ft(10, 6), -hd, -hw + ft(21, 0), -hd + ft(12, 0))),
            ("bedroom-03", "bedroom", rect_zone(-hw + ft(21, 0), -hd, -hw + ft(31, 6), -hd + ft(12, 0))),
            ("bedroom-04", "bedroom", rect_zone(-hw + ft(31, 6), -hd, -hw + ft(42, 0), -hd + ft(12, 0))),
            ("bath-01", "bath", rect_zone(-hw, -hd + ft(12, 0), -hw + ft(10, 0), hd - ft(2, 5))),
            ("living", "living", rect_zone(-hw + ft(10, 0), -hd + ft(12, 0), -hw + ft(28, 9), hd - ft(2, 5))),
            ("dining", "dining", rect_zone(-hw + ft(28, 9), -hd + ft(12, 0), -hw + ft(40, 0), hd - ft(2, 5))),
            ("kitchen", "kitchen", rect_zone(-hw + ft(42, 0), -hd, hw, -hd + ft(12, 0))),
        ],
        notch=(round(-hw + ft(40, 0), 4), round(hd - ft(2, 5), 4), hw, hd),
        bedrooms=4, adaptable=True,
        summary="Four-bedroom suite with a notch on one corner. The sheet shows "
                "the plan stepping back there; the step is kept rather than "
                "squared off.")

    # --- D2 four-bedroom with pantry: 48'-11" ----------------------------
    w, d = ft(48, 11), ft(23, 4)
    hw, hd = w / 2, d / 2
    types["unit-d2"] = unit_type(
        "unit-d2", "Four bedroom — Type D2", "Unit D2", w, d,
        [
            ("bedroom-01", "bedroom-accessible", rect_zone(-hw, -hd, -hw + ft(11, 6), -hd + ft(12, 0))),
            ("bedroom-02", "bedroom-accessible", rect_zone(-hw + ft(11, 6), -hd, -hw + ft(23, 0), -hd + ft(12, 0))),
            ("bedroom-03", "bedroom", rect_zone(-hw + ft(23, 0), -hd, -hw + ft(34, 0), -hd + ft(12, 0))),
            ("bedroom-04", "bedroom", rect_zone(-hw + ft(34, 0), -hd, -hw + ft(45, 0), -hd + ft(12, 0))),
            ("bath-01", "bath", rect_zone(-hw, -hd + ft(12, 0), -hw + ft(10, 0), hd)),
            ("living", "living", rect_zone(-hw + ft(10, 0), -hd + ft(12, 0), -hw + ft(24, 0), hd)),
            ("dining", "dining", rect_zone(-hw + ft(24, 0), -hd + ft(12, 0), -hw + ft(34, 0), hd)),
            ("pantry", "pantry", rect_zone(-hw + ft(34, 0), -hd + ft(12, 0), -hw + ft(39, 0), hd)),
            ("kitchen", "kitchen", rect_zone(-hw + ft(39, 0), -hd + ft(12, 0), hw, hd)),
            ("bath-02", "bath", rect_zone(-hw + ft(45, 0), -hd, hw, -hd + ft(12, 0))),
        ],
        bedrooms=4, mobility=True,
        summary="Four-bedroom suite with two accessible bedrooms and a pantry.")

    # ---------------------------------------------------------- variants ---
    variants = {}

    def core(x0, note):
        return [
            box_room("stair", "stair", x0, 0, x0 + ft(11, 0), ft(23, 4),
                     note=note),
            box_room("elevator", "elevator", x0 + ft(11, 0), 0, x0 + ft(19, 0), ft(14, 0),
                     note=note),
            box_room("shaft", "shaft", x0 + ft(11, 0), ft(14, 0), x0 + ft(19, 0), ft(23, 4),
                     note=note),
        ]

    CORE_NOTE = ("The set names shafts, stairs and an elevator but locates none of "
                 "them. This core is a study placement.")

    # residential-a — the typical plate. Levels 03, 05, 06.
    n, n_end = run(types, ["unit-d2", "unit-b1", ("gap", ft(19, 0)), "unit-s1",
                           "unit-s1", "unit-d1"], 0.0, NORTH_C)
    s, s_end = run(types, ["unit-d1-1", "unit-b2", "unit-s1", "unit-s1"], 0.0, SOUTH_C)
    plate_len = ft(190)
    south_end = ft(140)
    variants["variant-residential-a"] = variant(
        "variant-residential-a", "Residential A — typical plate", "residential",
        [[0, 0], [plate_len, 0], [plate_len, round(UNIT_DEPTH + CORRIDOR_W, 4)],
         [south_end, round(UNIT_DEPTH + CORRIDOR_W, 4)], [south_end, PLATE_DEPTH],
         [0, PLATE_DEPTH]],
        n, s, ceiling=CEIL_TYPICAL,
        common=[box_room("lounge", "study", ft(150), 0, ft(168), ft(23, 4),
                         note="A shared room on a residential level is an assumption. "
                              "The set does not schedule common area.")],
        service=[box_room("laundry", "laundry", ft(168), 0, ft(178), ft(23, 4),
                          note="Assumed. Not scheduled in the available set.")],
        vertical=core(ft(26, 0), CORE_NOTE),
        corridor_extent=[0, plate_len],
        evidence={
            "state": "unresolved",
            "basis": "No floor plate is drawn in the available set. The plate depth "
                     "is twice the unit depth that repeats on every unit sheet plus "
                     "a code-minimum corridor; the length follows from the units laid "
                     "along it. Nothing fixes the outline, the corridor, or the core.",
        },
        notes=["Assigned to three levels as a repeat. Only level 05 has a unit tagged "
               "on it in the available set; levels 03 and 06 have none at all, so "
               "repeating this plate there is an assumption and is marked as one."])

    # residential-b — the level with the widest tagged mix, and the mobility units.
    n, _ = run(types, ["unit-d1", "unit-b1", ("gap", ft(19, 0)), "unit-s1",
                       "unit-d2", "unit-s1"], 0.0, NORTH_C)
    s, _ = run(types, ["unit-d1-1", "unit-d2", "unit-b1", "unit-s1"], ft(26), SOUTH_C)
    plate_len = ft(190)
    variants["variant-residential-b"] = variant(
        "variant-residential-b", "Residential B — accessible mix", "residential",
        [[0, 0], [plate_len, 0], [plate_len, PLATE_DEPTH], [ft(26), PLATE_DEPTH],
         [ft(26), round(UNIT_DEPTH + CORRIDOR_W, 4)], [0, round(UNIT_DEPTH + CORRIDOR_W, 4)]],
        n, s, ceiling=CEIL_TYPICAL,
        common=[box_room("lounge", "study", ft(172), 0, ft(188), ft(23, 4),
                         note="Assumed.")],
        service=[box_room("trash", "trash", ft(172), round(UNIT_DEPTH + CORRIDOR_W, 4),
                          ft(184), PLATE_DEPTH, note="Assumed.")],
        vertical=core(ft(26, 0), CORE_NOTE),
        corridor_extent=[0, plate_len],
        evidence={
            "state": "unresolved",
            "basis": "This level carries the widest set of unit tags in the available "
                     "material, including both mobility types. That establishes which "
                     "types occur on it. It does not establish how many, or where.",
        },
        notes=["Unit tags in the set place studio, two-bedroom, four-bedroom and both "
               "mobility types on this level. The mix shown is drawn from those tags; "
               "the count and the arrangement are not stated anywhere."])

    # residential-c — the top level. Shorter plate.
    n, _ = run(types, ["unit-b2", "unit-b2", ("gap", ft(19, 0)), "unit-d1", "unit-s1"],
               0.0, NORTH_C)
    s, _ = run(types, ["unit-d2", "unit-b1", "unit-b2", "unit-s1"], 0.0, SOUTH_C)
    plate_len = ft(164)
    variants["variant-residential-c"] = variant(
        "variant-residential-c", "Residential C — upper plate", "residential",
        [[0, 0], [plate_len, 0], [plate_len, PLATE_DEPTH], [0, PLATE_DEPTH]],
        n, s, ceiling=CEIL_TYPICAL,
        common=[box_room("lounge", "study", ft(146), 0, ft(162), ft(23, 4),
                         note="Assumed.")],
        service=[],
        vertical=core(ft(26, 0), CORE_NOTE),
        corridor_extent=[0, plate_len],
        evidence={
            "state": "unresolved",
            "basis": "One unit tag in the set falls on the top level. It fixes a type, "
                     "not a plate. The shorter outline shown here is a study choice.",
        },
        notes=["The two-bedroom type that carries the accessibility readout is placed "
               "on this level because the only tag for it in the set is a top-level "
               "tag. Nothing else about this plate is established."])

    # entry — level 01. Podium footprint, taller, mostly not residential.
    n, _ = run(types, ["unit-s1"], ft(150), NORTH_C)
    variants["variant-entry"] = variant(
        "variant-entry", "Entry level", "entry",
        [[ft(-14), ft(-14)], [ft(204), ft(-14)], [ft(204), round(PLATE_DEPTH + ft(14), 4)],
         [ft(-14), round(PLATE_DEPTH + ft(14), 4)]],
        n, [], ceiling=CEIL_LEVEL_1,
        common=[
            box_room("lobby", "lobby", ft(20), ft(-10), ft(60), ft(23, 4),
                     note="The set states a podium and a taller level 1 but schedules "
                          "no entry sequence. Assumed."),
            box_room("mail", "mail", ft(60), ft(-10), ft(76), ft(10, 0), note="Assumed."),
            box_room("study-lounge", "study", ft(76), ft(-10), ft(110), ft(23, 4),
                     note="Assumed."),
        ],
        service=[
            box_room("bike", "bike", ft(-10), ft(-10), ft(20), ft(23, 4), note="Assumed."),
            box_room("trash", "trash", ft(110), ft(-10), ft(126), ft(23, 4), note="Assumed."),
            box_room("mechanical", "mechanical", ft(126), ft(-10), ft(150), ft(23, 4),
                     note="Assumed."),
        ],
        vertical=core(ft(26, 0), CORE_NOTE),
        corridor_extent=[ft(-10), ft(200)],
        evidence={
            "state": "derived",
            "basis": "Two things about level 1 are stated in the set: its units have a "
                     "10'-0\" ceiling where level 2 has 9'-0\", and it sits in a detail "
                     "regime shared only with level 2, over a podium. A taller, "
                     "differently-occupied ground level follows from that. What "
                     "occupies it does not.",
        },
        notes=["The role of this level is derived from a stated ceiling height and a "
               "stated podium. The rooms shown are an assumed entry programme.",
               "One mobility studio is tagged on this level in the available set, so a "
               "dwelling unit is placed here; its position is not established."])

    # podium-mixed — level 02. Shares the level 1 detail regime, 9'-0" ceiling.
    n, _ = run(types, ["unit-d2", "unit-b1", ("gap", ft(19, 0)), "unit-s1", "unit-s1"],
               0.0, NORTH_C)
    s, _ = run(types, ["unit-b2", "unit-s1"], 0.0, SOUTH_C)
    plate_len = ft(190)
    variants["variant-podium-mixed"] = variant(
        "variant-podium-mixed", "Podium level — mixed", "mixed",
        [[0, 0], [plate_len, 0], [plate_len, round(UNIT_DEPTH + CORRIDOR_W, 4)],
         [ft(100), round(UNIT_DEPTH + CORRIDOR_W, 4)], [ft(100), PLATE_DEPTH], [0, PLATE_DEPTH]],
        n, s, ceiling=CEIL_TYPICAL,
        common=[box_room("amenity", "study", ft(120), 0, ft(150), ft(23, 4),
                         note="Assumed.")],
        service=[box_room("laundry", "laundry", ft(150), 0, ft(166), ft(23, 4),
                          note="Assumed.")],
        vertical=core(ft(26, 0), CORE_NOTE),
        corridor_extent=[0, plate_len],
        evidence={
            "state": "unresolved",
            "basis": "Level 2 shares a detail regime with level 1 and has a stated "
                     "9'-0\" ceiling, so it is distinguished from the levels above. No "
                     "unit is tagged on it anywhere in the available set, and nothing "
                     "states what it contains.",
        },
        notes=["The terrace void over the podium is a study choice. It is drawn "
               "because level 2 is distinguished from the levels above it in the set, "
               "not because any drawing shows a void here."])

    # ----------------------------------------------------------- building ---
    f2f_1 = ft(11)
    f2f_typ = ft(10)
    assignments = [
        (1, "variant-entry", "Entry level", f2f_1),
        (2, "variant-podium-mixed", "Podium level", f2f_typ),
        (3, "variant-residential-a", "Residential", f2f_typ),
        (4, "variant-residential-b", "Residential", f2f_typ),
        (5, "variant-residential-a", "Residential", f2f_typ),
        (6, "variant-residential-a", "Residential", f2f_typ),
        (7, "variant-residential-c", "Residential", f2f_typ),
    ]
    levels = []
    y = 0.0
    for level, vid, role, f2f in assignments:
        levels.append({
            "id": f"floor-{level:02d}",
            "level": level,
            "name": f"Level {level:02d}",
            "role": role,
            "variant": vid,
            "elevation": {"value": round(y, 4), "unit": "m", "truth": "derived",
                          "note": "Stacked from floor-to-floor figures that are "
                                  "themselves derived from stated ceiling heights. No "
                                  "elevation is given in the available set."},
            "floorToFloor": {"value": f2f, "unit": "m", "truth": "derived",
                             "note": "Ceiling height is stated; structural depth is "
                                     "assumed to reach floor-to-floor."},
        })
        y += f2f

    building = {
        "schema": "parametric-study.building.v2",
        "id": "building-a",
        "name": "Multifamily Student Housing",
        "container": "parametric study",
        "truth": "unresolved",
        "_comment": "Seven levels, each assigned an explicit floor-plan variant. The "
                    "split between levels 1-2 and levels 3-7 is the one piece of "
                    "level structure the available set states outright; it appears "
                    "twice in the detail references and once as a difference in stated "
                    "ceiling height. Everything spatial - plate outlines, corridor and "
                    "core positions, unit counts and unit positions - is a study "
                    "arrangement and is marked unresolved wherever it is shown.",
        "levelStructure": {
            "truth": "derived",
            "note": "Levels 1-2 and levels 3-7 are treated as two regimes because the "
                    "set partitions them that way. Which of levels 3-7 are identical "
                    "is not stated, so levels with no evidence repeat one plate and "
                    "say so.",
        },
        "levels": levels,
        "types": {tid: f"types/{tid}.json" for tid in types},
        "variants": {vid: f"levels/{vid}.json" for vid in variants},
    }

    # ------------------------------------------------------------- write ---
    (ROOT / "levels").mkdir(exist_ok=True)
    written = []
    for tid, payload in types.items():
        path = ROOT / "types" / f"{tid}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n")
        written.append(path)
    for vid, payload in variants.items():
        path = ROOT / "levels" / f"{vid}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n")
        written.append(path)
    path = ROOT / "building.json"
    path.write_text(json.dumps(building, indent=2) + "\n")
    written.append(path)

    for p in written:
        print(f"  wrote {p.relative_to(ROOT)}")
    print(f"\n  {len(types)} unit types, {len(variants)} floor-plan variants, "
          f"{len(levels)} levels")
    for lv in levels:
        v = variants[lv["variant"]]
        print(f"    {lv['name']}  {lv['role']:12} {v['name']:34} "
              f"{len(v['units'])} units")


if __name__ == "__main__":
    build()
