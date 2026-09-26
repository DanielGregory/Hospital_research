/** The career in progress, kept in the browser. Rules live in the sim (`career`); this only stores them. */
import { career, LIVE_CALLS, type CareerState, type LiveCall, type PlayerControl } from '@er/sim';

const KEY = 'er-career';

export function loadCareer(): CareerState | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as CareerState | null;
    return s && s.version === 1 ? s : null;
  } catch {
    return null;
  }
}

export function saveCareer(s: CareerState | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the career lasts as long as the tab.
  }
}

/** A career seed from the hospital name and the moment it was founded (FNV-1a). */
export function careerSeed(name: string, foundedAt: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${name}|${foundedAt}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/** What the player can change during a live week. Beds and shifts are set between weeks. */
export function careerLive(s: CareerState): { controls: PlayerControl[]; calls: readonly LiveCall[] } {
  const ft = s.hospital.upgrades.includes('fastTrackArea');
  return { controls: ['queue.discipline', ...(ft ? (['fastTrack.enabled'] as PlayerControl[]) : [])], calls: LIVE_CALLS };
}

export const money = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

export { career };
