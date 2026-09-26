/**
 * Apply dot-path settings to a config, e.g. { "staffing.doctors": 4 }.
 * Used by the game (player setup), the headless CLI (--set) and research tools.
 * Returns a deep copy; the input is not modified.
 */
export type Settings = Record<string, unknown> | readonly (readonly [string, unknown])[];

export function applySettings<T>(config: T, settings: Settings): T {
  const out = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const entries = Array.isArray(settings) ? settings : Object.entries(settings);
  for (const [path, value] of entries as [string, unknown][]) {
    const keys = path.split('.');
    let cur = out;
    for (const k of keys.slice(0, -1)) {
      const next = cur[k];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[keys[keys.length - 1]!] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return out as T;
}

/** Read a dot path from any object (undefined if missing). */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
