/**
 * src/processing/scheduler.ts
 * -----------------------------------------------------------------------------
 * Schedule queue math (task 26).
 *
 * Pure function: given the current epoch ms and the list of pending scheduled
 * posts (their `scheduled_for` values) for the same user, compute the
 * `scheduled_for` epoch ms for a NEW post.
 *
 * RULES (per the user's spec):
 *   1. Default delay: 24 hours from receipt. So a brand-new queue (no
 *      pending) places the post at `now + 24h`.
 *   2. Posts are spaced by `intervalHours`.
 *   3. Max `messagesPerDay` posts per 24-hour cycle. A cycle is the 24h
 *      window that begins at the FIRST pending post's `scheduled_for`.
 *   4. When the current cycle is full, the post rolls into the next cycle,
 *      which starts 24h after the current cycle's start.
 *
 * Example (messagesPerDay=2, intervalHours=12h):
 *   Post A arrives at T → scheduled_for = T + 24h           (cycle 1, slot 0)
 *   Post B arrives at T+1h → scheduled_for = T + 24h + 12h  (cycle 1, slot 1)
 *   Post C arrives at T+2h → cycle 1 is full (2/2).
 *                             cycle 2 starts at T + 24h + 24h = T + 48h.
 *                             scheduled_for = T + 48h       (cycle 2, slot 0)
 *
 * Inconsistent combinations (intervalHours * messagesPerDay > 24h) are
 * tolerated: the cycle effectively lasts longer than 24h. We never collide
 * with the previous post (we always pick max(cycle_start + k*interval,
 * last_in_cycle + interval)).
 *
 * This module has NO I/O — it's pure so it's trivially testable and the
 * caller (pipeline) can mock it. The D1 read of pending posts lives in
 * `storage/repositories/jobs.ts` (`listPendingScheduledForUser`).
 * -----------------------------------------------------------------------------
 */

import { SCHEDULE_CYCLE_MS } from "../config/defaults";

/**
 * Compute the next `scheduled_for` epoch ms for a new post.
 *
 * @param now                  current epoch ms (Date.now())
 * @param pendingScheduledFors sorted-ASC list of `scheduled_for` values of
 *                             the user's pending scheduled_post jobs. Past
 *                             (overdue) entries are ignored — they'll be
 *                             published by the cron soon and shouldn't block
 *                             new scheduling.
 * @param messagesPerDay       max posts per 24h cycle (validated upstream:
 *                             one of 1,2,3,4,6,8,12,24)
 * @param intervalHours        hours between posts (validated upstream:
 *                             one of 1,2,3,4,6,8,12,24)
 * @returns                    epoch ms for the new post's scheduled_for
 */
export function computeNextScheduledTime(
  now: number,
  pendingScheduledFors: number[],
  messagesPerDay: number,
  intervalHours: number,
): number {
  // Defensive: treat invalid config as the daily default so the bot never
  // crashes on a corrupt settings row.
  const perDay = Number.isFinite(messagesPerDay) && messagesPerDay >= 1
    ? Math.floor(messagesPerDay)
    : 1;
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours >= 1
      ? Math.floor(intervalHours) * 60 * 60 * 1000
      : SCHEDULE_CYCLE_MS;

  // Only future pending posts matter — past (overdue) ones are about to be
  // published by the cron and shouldn't occupy a slot.
  const future = pendingScheduledFors
    .filter((t) => Number.isFinite(t) && t > now)
    .sort((a, b) => a - b);

  // Empty queue → 24h from now (rule 1).
  if (future.length === 0) {
    return now + SCHEDULE_CYCLE_MS;
  }

  // Walk pending posts grouped into 24h cycles. The first cycle starts at
  // future[0]. Each subsequent cycle starts 24h after the previous one.
  let cycleStart = future[0];
  let i = 0;
  while (i < future.length) {
    const cycleEnd = cycleStart + SCHEDULE_CYCLE_MS;
    let countInCycle = 0;
    let lastInCycle = cycleStart;
    while (i < future.length && future[i] < cycleEnd) {
      lastInCycle = future[i];
      countInCycle++;
      i++;
    }

    if (countInCycle < perDay) {
      // Free slot in this cycle. Position = countInCycle (0-indexed), so the
      // candidate is cycleStart + countInCycle * intervalMs. Guard against
      // overlapping the previous slot when intervalMs is small relative to
      // the time the previous post was inserted at.
      const candidate = cycleStart + countInCycle * intervalMs;
      return Math.max(candidate, lastInCycle + intervalMs);
    }

    // Cycle full — advance to the next cycle (24h later).
    cycleStart = cycleEnd;
  }

  // All cycles full; the loop above advanced cycleStart to the next free
  // cycle's start. Slot 0 of the new cycle.
  return cycleStart;
}
