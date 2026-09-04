# BookForgeAI — Visual Canon

## Purpose

Recurring visual entities are designed before ordinary illustration generation to reduce visual drift.

## Pipeline

```text
BOOK MAP → ASSET DISCOVERY → ASSET DESIGN → REFERENCE GENERATION
→ USER APPROVAL → LOCK → ILLUSTRATION → VISUAL QA
```

## Asset types

Character, creature, animal, object, vehicle, weapon, building, location, symbol, clothing and recurring prop.

## Character Bible

Identity, age/scale, species, proportions, face, hair/fur/scales, eyes, clothing, accessories, distinguishing marks, palette, personality, style and approved reference images.

## Item Bible

Shape, relative size, material, colour, markings, damage, unique features, style and approved references.

## Locked assets

Approved assets are marked `LOCKED`. A change requires a new version and approval.

## Reference generation

Primary and secondary assets receive a reference sheet. Background props do not: their canon reaches the director and QA as text, which is what scenes actually used.

## Scene specification

Every illustration identifies assets, location, time, weather, action, emotion, camera, composition, lighting, style and required references. A chapter keeps at most `MAX_SCENES_PER_CHAPTER` scenes (default two), and asset names are mapped onto the registry's spellings when the specification is committed, so a close spelling still attaches its reference art.

## QA

Check identity, proportions, clothing, colours, markings, props, location continuity, style and scene requirements. QA sees the render and, beside it, the reference sheet of the scene's first required reference (named in its context). A verdict passes when no check fails and no critical failure is listed; that flag is derived, and it is the same one publication is gated on. A failed render is redone once (`MAX_IMAGE_ATTEMPTS`), steered by the failed checks, and the new render is judged afresh. A render still failing when its attempts are spent is recorded (`ILLUSTRATION_UNRESOLVED`) and left for a person; publication stays blocked until it passes.

Consistency is probabilistic; the system should reduce drift through canonical specifications, approved references, image inputs/editing and QA, not claim perfect identity.
