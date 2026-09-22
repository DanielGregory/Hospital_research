/** Canvas drawing of a FloorPlan. Colours come from CSS custom properties so dark mode works. */
import type { Acuity } from '@er/sim';
import { WAITING_LINE_LABELS, type FloorPlan } from './floorPlan';

function css(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function acuityColor(a: Acuity | undefined): string {
  if (a === undefined) return css('--untriaged', '#9aa0a6');
  return css(`--esi-${a}`, '#888');
}

export function drawFloor(ctx: CanvasRenderingContext2D, plan: FloorPlan, width: number, height: number, showFastTrack: boolean) {
  const bg = css('--canvas-bg', '#fafaf8');
  const areaBg = css('--area-bg', '#ffffff');
  const line = css('--line', '#d9d9d4');
  const ink = css('--ink', '#1f1f1c');
  const muted = css('--muted', '#6b6b66');
  const staffColor = css('--staff', '#3b5bdb');

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.font = '600 13px system-ui, sans-serif';
  for (const a of plan.areas) {
    ctx.fillStyle = areaBg;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillText(a.label, a.x + 12, a.y + 20);
  }

  const waiting = plan.areas.find((a) => a.id === 'waiting')!;
  const lines = showFastTrack ? 3 : 2;
  const lineH = (waiting.h - 30) / lines;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = muted;
  for (let i = 0; i < lines; i++) ctx.fillText(WAITING_LINE_LABELS[i]!, waiting.x + 12, waiting.y + 30 + i * lineH + 12);

  for (const s of plan.staff) {
    ctx.globalAlpha = s.leaving ? 0.4 : 1;
    ctx.fillStyle = staffColor;
    ctx.fillRect(s.x - 7, s.y - 7, 14, 14);
    if (!s.busy) {
      ctx.fillStyle = areaBg;
      ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
    }
    ctx.globalAlpha = 1;
  }

  for (const p of plan.patients) {
    ctx.fillStyle = acuityColor(p.acuity);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    if (p.waited > 120) {
      // Long waits get a ring so they stand out.
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
