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

## Scene specification

Every illustration identifies assets, location, time, weather, action, emotion, camera, composition, lighting, style and required references.

## QA

Check identity, proportions, clothing, colours, markings, props, location continuity, style and scene requirements. Critical failures trigger rejection/regeneration.

Consistency is probabilistic; the system should reduce drift through canonical specifications, approved references, image inputs/editing and QA, not claim perfect identity.
