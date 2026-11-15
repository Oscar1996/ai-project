// ─── Refund Policy ───
// The limits that decide whether a learner may request a refund. Shared by the
// request route and the platform admin's review screen, which shows each
// request's progress next to the same limits.

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_HOURS = 2;
export const MAX_WATCHED_SECONDS = MAX_WATCHED_HOURS * 60 * 60;
export const MAX_COMPLETED_LESSON_SHARE = 0.5;

// The refund window is counted in whole calendar days, not hours — someone who
// buys at 23:00 should still get the whole of their last day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export function isInsideRefundWindow(
  purchasedAtIso: string,
  now: Date = new Date()
): boolean {
  return calendarDay(now) <= lastDayOfRefundWindow(purchasedAtIso);
}

/** Whole calendar days left in the window; 0 on the last day, negative once closed. */
export function refundWindowDaysLeft(
  purchasedAtIso: string,
  now: Date = new Date()
): number {
  const [year, month, day] = lastDayOfRefundWindow(purchasedAtIso)
    .split("-")
    .map(Number);
  const lastDay = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((lastDay - today) / 86_400_000);
}
