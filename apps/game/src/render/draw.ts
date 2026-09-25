/** Canvas drawing of a FloorPlan. Colours come from CSS custom properties so light and dark both work. */
import type { Acuity, Role } from '@er/sim';
import type { FloorPlan } from './floorPlan';

export function css(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function acuityColor(a: Acuity | undefined): string {
  if (a === undefined) return css('--untriaged', '#9a9890');
  return css(`--esi-${a}`, '#888');
}

/** Black or white, whichever reads better on a hex colour. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return L > 0.3 ? '#1d1c19' : '#ffffff';
}

const ROLE_STYLE: Record<Role, { cssVar: string; letter: string }> = {
  doctor: { cssVar: '--staff', letter: 'D' },
  triageNurse: { cssVar: '--staff-triage', letter: 'T' },
  fastTrackClinician: { cssVar: '--staff-ft', letter: 'F' },
  nurse: { cssVar: '--staff-triage', letter: 'N' },
  tech: { cssVar: '--staff-ft', letter: 'X' },
  security: { cssVar: '--staff-security', letter: 'S' },
};

export function roleColor(role: Role): string {
  return css(ROLE_STYLE[role].cssVar, '#2553c9');
}
export const roleLetter = (role: Role) => ROLE_STYLE[role].letter;

export function drawFloor(ctx: CanvasRenderingContext2D, plan: FloorPlan, width: number, height: number) {
  const areaBg = css('--area-bg', '#ffffff');
  const areaHead = css('--area-head', '#f6f5f1');
  const line = css('--line', '#e3e0d8');
  const ink = css('--ink', '#1d1c19');
  const muted = css('--muted', '#76736b');
  const board = css('--boarding', '#7b4bd6');
  const bed = css('--bed', '#eeede8');
  const bedLine = css('--bed-line', '#d8d5cc');
  const ring = css('--dot-ring', '#ffffff');
  const fail = css('--fail', '#b3261e');

  ctx.clearRect(0, 0, width, height);

  if (plan.grid) {
    ctx.fillStyle = css('--corridor', '#e4e2da');
    for (const c of plan.grid.cells) ctx.fillRect(c.x, c.y, c.w + 0.5, c.h + 0.5);
    const e = plan.grid.entrance;
    const accent = css('--accent', '#2553c9');
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(e.x + e.w * 0.2, e.y + e.h * 0.2, e.w * 0.6, e.h * 0.6, 3);
    ctx.fill();
    ctx.font = '650 10px system-ui, sans-serif';
    ctx.fillText('Entrance', e.x + e.w + 4, e.y + e.h / 2 + 3);
  }

  // Rooms: card with a header strip.
  for (const a of plan.areas) {
    const r = plan.grid ? 5 : 10;
    const head = plan.grid ? 14 : 30;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.06)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = a.kind ? css(`--room-${a.kind}`, areaBg) : areaBg;
    ctx.beginPath();
    ctx.roundRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1, r);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1, r);
    ctx.clip();
    ctx.fillStyle = areaHead;
    ctx.fillRect(a.x, a.y, a.w, head);
    ctx.restore();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1, r);
    ctx.stroke();
    ctx.fillStyle = ink;
    if (plan.grid) {
      ctx.font = '650 10px system-ui, sans-serif';
      ctx.fillText(a.label, a.x + 5, a.y + 10.5, Math.max(10, a.w - 8));
    } else {
      ctx.font = '650 13px system-ui, sans-serif';
      ctx.fillText(a.label, a.x + 12, a.y + 20);
    }
  }

  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  const waiting = plan.areas.find((a) => a.id === 'waiting');
  if (waiting) for (const l of plan.waitingLines) ctx.fillText(l.label.toUpperCase(), waiting.x + 12, l.y + 4);

  // Beds: a mattress with a pillow line; trauma bays outlined in red.
  const trauma = css('--trauma', '#b3261e');
  for (const b of plan.beds) {
    ctx.fillStyle = bed;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 5);
    ctx.fill();
    ctx.strokeStyle = b.trauma ? trauma : bedLine;
    ctx.lineWidth = b.trauma ? 2 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;
    if (b.w > 16) {
      ctx.beginPath();
      ctx.roundRect(b.x + 3, b.y + 3, Math.max(4, b.w * 0.22), b.h - 6, 3);
      ctx.stroke();
    }
  }

  // Patients: coloured by triage level, numbered, ringed so they separate from each other and the floor.
  const R = plan.grid ? Math.max(4.5, Math.min(7.5, plan.grid.cell * 0.28)) : 7.5;
  for (const p of plan.patients) {
    const colour = acuityColor(p.acuity);
    ctx.beginPath();
    ctx.arc(p.x, p.y, R + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    if (p.acuity !== undefined && R >= 7) {
      ctx.fillStyle = inkOn(colour);
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.acuity), p.x, p.y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
    if (p.boarding) {
      ctx.strokeStyle = board;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (p.waited > 120 || p.special === 'massCasualty') {
      ctx.strokeStyle = p.special === 'massCasualty' ? fail : ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Staff: a rounded tile in their role colour with an initial; hollow when free.
  const S = plan.grid ? Math.max(10, Math.min(16, plan.grid.cell * 0.6)) : 16;
  for (const s of plan.staff) {
    const colour = roleColor(s.role);
    ctx.globalAlpha = s.leaving ? 0.45 : 1;
    ctx.beginPath();
    ctx.roundRect(s.x - S / 2, s.y - S / 2, S, S, 4);
    if (s.busy) {
      ctx.fillStyle = colour;
      ctx.fill();
    } else {
      ctx.fillStyle = areaBg;
      ctx.fill();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (S >= 14) {
      ctx.fillStyle = s.busy ? inkOn(colour) : colour;
      ctx.font = '750 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(roleLetter(s.role), s.x, s.y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
    if (s.fatigue > 0.15) {
      ctx.fillStyle = fail;
      ctx.fillRect(s.x - S / 2, s.y + S / 2 + 2, Math.min(S, S * (s.fatigue / 0.5)), 2);
    }
    ctx.globalAlpha = 1;
  }
}
