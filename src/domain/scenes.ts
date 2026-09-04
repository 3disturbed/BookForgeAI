/**
 * Commit-time rules for scene specs. The composer names assets from memory and
 * the registry spells them canonically; on a measured run 59 of 644 scene
 * references matched no asset by exact name ("Toast" for "Toast (Warhound)"),
 * so the reference art those scenes had paid for was never attached and the
 * canon drifted. Names are mapped here, and the scene count is capped here,
 * because asking the model to comply does not hold.
 */
export interface NamedAsset {
  name: string;
  importance?: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Toast (Warhound)" is "toast" to a scene. */
const baseName = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

const asWord = (needle: string, haystack: string): boolean =>
  needle.length > 0 && new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(haystack);

const RANK: Record<string, number> = { primary: 0, secondary: 1 };
const rankOf = (asset: NamedAsset): number => RANK[asset.importance ?? ''] ?? 2;

/** Looser and looser readings of a spelling, tried in order. */
const TIERS: ((token: string, asset: NamedAsset) => boolean)[] = [
  (t, a) => baseName(a.name) === t,
  (t, a) => asWord(baseName(a.name), t),
  (t, a) => baseName(a.name).startsWith(`${t} `),
  (t, a) => asWord(t, a.name.toLowerCase()),
];

/**
 * The registry name a scene's spelling refers to. An exact match wins. Each
 * looser tier is accepted only when a single asset of the highest importance
 * among its candidates satisfies it, so a primary character's short name is
 * never rewritten onto a prop or place that shares its words; an ambiguous
 * spelling is kept as written. A spelling that matches nothing returns null.
 */
export function matchAssetName(token: string, assets: readonly NamedAsset[]): string | null {
  const t = token.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return null;
  const exact = assets.find((a) => a.name.toLowerCase() === t);
  if (exact) return exact.name;
  for (const tier of TIERS) {
    const candidates = assets.filter((a) => tier(t, a));
    if (candidates.length === 0) continue;
    const best = Math.min(...candidates.map(rankOf));
    const top = candidates.filter((a) => rankOf(a) === best);
    return top.length === 1 ? top[0]!.name : token.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** Names mapped onto the registry, each once; what matches nothing is dropped. */
export function mapAssetNames(list: unknown, assets: readonly NamedAsset[]): string[] {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((t) => matchAssetName(String(t), assets))
        .filter((n): n is string => n !== null),
    ),
  ];
}

interface SceneAssets {
  assets?: unknown;
  requiredReferences?: unknown;
  [k: string]: unknown;
}

/** Every asset reference in a scene spec spelt the registry's way. */
export function normaliseSceneAssets(data: unknown, assets: readonly NamedAsset[]): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const spec = data as { scenes?: unknown };
  if (!Array.isArray(spec.scenes)) return data;
  return {
    ...spec,
    scenes: (spec.scenes as SceneAssets[]).map((s) => ({
      ...s,
      assets: mapAssetNames(s.assets, assets),
      requiredReferences: mapAssetNames(s.requiredReferences, assets),
    })),
  };
}

/** The first `max` scenes of a chapter; the composer lists them in order of importance. */
export function capScenes(data: unknown, max: number): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const spec = data as { scenes?: unknown };
  if (!Array.isArray(spec.scenes)) return data;
  return { ...spec, scenes: spec.scenes.slice(0, Math.max(1, max)) };
}
