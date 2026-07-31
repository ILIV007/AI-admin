/**
 * src/processing/scheduler.ts
 * -----------------------------------------------------------------------------
 * Schedule system with FIXED DAILY TIME SLOTS in Asia/Tehran timezone.
 *
 * Design (v2.9.5 — replaces the old "24h delay + interval" model):
 *   - The day is divided into N equal slots starting from scheduleStartHour.
 *   - Example: 4 slots starting at 09:00 → 09:00, 15:00, 21:00, 03:00 (next day)
 *     Actually: with 4 slots, interval = 24/4 = 6h, so 09:00, 15:00, 21:00, 03:00.
 *   - When a post arrives, it's assigned to the NEXT AVAILABLE slot.
 *   - "Available" = the slot time is in the future AND no pending job
 *     already occupies it (rounded to the minute).
 *   - When all of today's slots are taken, roll to tomorrow's first slot.
 *   - All times are computed in Asia/Tehran timezone (handles +03:30 offset
 *     and any future DST changes via Intl.DateTimeFormat).
 *
 * This module is PURE (no I/O) so it's trivially testable and the caller
 * (pipeline) can mock it. The D1 read of pending posts lives in
 * `storage/repositories/jobs.ts` (`listPendingScheduledForUser`).
 * -----------------------------------------------------------------------------
 */

const TEHRAN_TZ = "Asia/Tehran";

/**
 * Get the current time in Tehran as { y, mo (0-11), d, h, mi }.
 *
 * Uses Intl.DateTimeFormat with timeZone so it correctly handles the +03:30
 * offset without hardcoding it (future-proof against DST re-introduction).
 */
function tehranNow(): { y: number; mo: number; d: number; h: number; mi: number } {
  const now = new Date();
  return tehranParts(now);
}

/**
 * Format an arbitrary Date into Tehran wall-clock components.
 */
function tehranParts(date: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TEHRAN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      const v = parseInt(p.value, 10);
      if (!Number.isNaN(v)) map[p.type] = v;
    }
  }
  // Intl can emit "24" for midnight; normalize to 0.
  return {
    y: map.year,
    mo: map.month - 1,
    d: map.day,
    h: map.hour === 24 ? 0 : map.hour,
    mi: map.minute,
  };
}

/**
 * Convert a Tehran wall-clock time to UTC epoch ms.
 *
 * Builds a UTC date with Tehran's wall-clock components, then corrects by
 * Tehran's UTC offset at that instant (computed via Intl).
 */
function tehranToEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  const wallAsUtc = Date.UTC(y, mo, d, h, mi, 0, 0);
  // Compute Tehran's offset by formatting `new Date(wallAsUtc)` in Tehran
  // and comparing the wall-clock reading to the UTC value.
  const probe = new Date(wallAsUtc);
  const tn = tehranParts(probe);
  const tehranWall = Date.UTC(tn.y, tn.mo, tn.d, tn.h, tn.mi, 0, 0);
  const offsetMs = tehranWall - probe.getTime();
  return wallAsUtc - offsetMs;
}

/**
 * Compute the N daily slot times (as UTC epoch ms) for a given Tehran day.
 *
 * Slots are evenly spaced: slot i is at startHour + i * (24 / slotsPerDay).
 * Example: slotsPerDay=4, startHour=9 → 09:00, 15:00, 21:00, 03:00 (+1d).
 *
 * @param y, mo, d  Tehran date components (mo is 0-11)
 * @param startHour Start hour in Tehran (0-23)
 * @param slotsPerDay Number of slots (1-8)
 * @returns Array of UTC epoch ms, one per slot, sorted ascending.
 */
function computeDaySlots(
  y: number,
  mo: number,
  d: number,
  startHour: number,
  slotsPerDay: number,
): number[] {
  const intervalHours = 24 / slotsPerDay;
  const slots: number[] = [];
  for (let i = 0; i < slotsPerDay; i++) {
    const slotHourFloat = startHour + i * intervalHours;
    // Handle overflow past midnight (e.g. slot at 27:00 = 03:00 next day)
    const dayOffset = Math.floor(slotHourFloat / 24);
    const hourFloat = slotHourFloat % 24;
    const hour = Math.floor(hourFloat);
    const minute = Math.round((hourFloat % 1) * 60);
    // Build the base date (Tehran y/mo/d) + dayOffset
    const baseDate = new Date(Date.UTC(y, mo, d + dayOffset));
    slots.push(
      tehranToEpoch(
        baseDate.getUTCFullYear(),
        baseDate.getUTCMonth(),
        baseDate.getUTCDate(),
        hour,
        minute,
      ),
    );
  }
  return slots;
}

/**
 * Compute the next scheduled time for a new post.
 *
 * RANDOM DISTRIBUTION: instead of always picking the FIRST free slot, we
 * collect ALL free slots (today + tomorrow + day after) and pick one at
 * random. This means if the admin sends 4 posts and there are 4 slots
 * today, they get randomly distributed across the slots (e.g. slots
 * 3,1,4,2) rather than sequentially filling 1,2,3,4. This creates variety
 * so the channel doesn't always post in the same order.
 *
 * @param nowMs                 Current epoch ms (Date.now())
 * @param pendingScheduledFors  scheduled_for values of existing pending jobs
 *                              (past/overdue entries are ignored — they'll be
 *                              published by the cron soon).
 * @param slotsPerDay           Number of daily slots (1-8, clamped)
 * @param startHour             Start hour in Tehran (0-23, default 9)
 * @returns                     Epoch ms for the new post's scheduled_for
 */
export function computeNextScheduledTime(
  nowMs: number,
  pendingScheduledFors: number[],
  slotsPerDay: number,
  startHour: number = 9,
): number {
  const perDay = Math.max(1, Math.min(8, Math.floor(slotsPerDay)));
  const start = Math.max(0, Math.min(23, Math.floor(startHour)));

  // Get current Tehran date
  const tn = tehranNow();

  // Build a set of occupied slot times (rounded to minute precision) — only
  // FUTURE pending posts count (past ones are about to be published).
  const occupied = new Set(
    pendingScheduledFors
      .filter((t) => Number.isFinite(t) && t > nowMs)
      .map((t) => Math.round(t / 60000) * 60000), // round to minute
  );

  // Collect ALL free slots across today + tomorrow + day after.
  // We prefer today's remaining slots; if none are free today, use tomorrow's;
  // if tomorrow is also full, use day after.
  const freeSlotsByDay: number[][] = [];
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const date = new Date(Date.UTC(tn.y, tn.mo, tn.d + dayOffset));
    const slots = computeDaySlots(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      start,
      perDay,
    );
    const freeToday: number[] = [];
    for (const slotTime of slots) {
      // Skip past slots (slot time already happened today)
      if (slotTime <= nowMs) continue;
      // Skip occupied slots
      const rounded = Math.round(slotTime / 60000) * 60000;
      if (occupied.has(rounded)) continue;
      freeToday.push(slotTime);
    }
    freeSlotsByDay.push(freeToday);
  }

  // Pick the FIRST day that has free slots (today first, then tomorrow, etc.).
  for (const freeSlots of freeSlotsByDay) {
    if (freeSlots.length > 0) {
      // RANDOM distribution: pick a random slot from the free ones.
      // This distributes posts across available slots rather than always
      // filling slot 1 first, then slot 2, etc.
      const idx = Math.floor(Math.random() * freeSlots.length);
      return freeSlots[idx];
    }
  }

  // Fallback: 24h from now (should never reach here under normal config)
  return nowMs + 24 * 60 * 60 * 1000;
}

/**
 * Compute a human-readable preview of today's slot times for display in the
 * schedule settings menu. Returns strings like "09:00", "15:00", etc.
 *
 * @param slotsPerDay Number of daily slots (1-8)
 * @param startHour   Start hour in Tehran (0-23)
 * @returns Array of "HH:MM" strings (Tehran wall-clock).
 */
export function computeDaySlotsPreview(
  slotsPerDay: number,
  startHour: number,
): string[] {
  const perDay = Math.max(1, Math.min(8, Math.floor(slotsPerDay)));
  const start = Math.max(0, Math.min(23, Math.floor(startHour)));
  const intervalHours = 24 / perDay;
  const result: string[] = [];
  for (let i = 0; i < perDay; i++) {
    const h = (start + i * intervalHours) % 24;
    const hh = String(Math.floor(h)).padStart(2, "0");
    const mm = String(Math.round((h % 1) * 60)).padStart(2, "0");
    result.push(`${hh}:${mm}`);
  }
  return result;
}

/**
 * Build a calendar view of scheduled posts for the schedule UI.
 *
 * Groups pending scheduled posts by Tehran day, then for each day shows the
 * slot times and which post (if any) is assigned to each slot.
 *
 * @param pendingJobs   Array of pending scheduled_post jobs (from D1).
 * @param slotsPerDay   Number of daily slots (1-8).
 * @param startHour     Start hour in Tehran (0-23).
 * @param maxDays       Max number of days to show (default 7).
 * @returns Array of day-views, each with date + slots + assigned posts.
 */
export interface ScheduleDayView {
  /** Tehran date label, e.g. "امروز (چهارشنبه)" or "فردا (پنجشنبه)". */
  dayLabel: string;
  /** Tehran date in "YYYY-MM-DD" format for sorting/comparison. */
  dateKey: string;
  /** Slots for this day, with assigned post (if any). */
  slots: ScheduleSlotView[];
  /** Number of occupied slots. */
  occupiedCount: number;
}

export interface ScheduleSlotView {
  /** Slot time in "HH:MM" format (Tehran). */
  time: string;
  /** The slot's epoch ms (UTC). */
  epoch: number;
  /** True if a post is assigned to this slot. */
  occupied: boolean;
  /** If occupied, a short preview of the post text (first 60 chars). */
  postPreview?: string;
  /** If occupied, the job ID. */
  jobId?: string;
}

export function buildScheduleCalendarView(
  pendingJobs: { id: string; scheduledFor: number | null; payload: string }[],
  slotsPerDay: number,
  startHour: number,
  maxDays: number = 7,
  lang: "en" | "fa" = "en",
): ScheduleDayView[] {
  const perDay = Math.max(1, Math.min(8, Math.floor(slotsPerDay)));
  const start = Math.max(0, Math.min(23, Math.floor(startHour)));
  const now = Date.now();
  const tn = tehranNow();

  // Build a map: epoch ms (rounded to minute) → job
  const jobMap = new Map<number, { id: string; preview: string }>();
  for (const job of pendingJobs) {
    if (job.scheduledFor == null || !Number.isFinite(job.scheduledFor)) continue;
    const rounded = Math.round(job.scheduledFor / 60000) * 60000;
    let preview = "";
    try {
      const p = JSON.parse(job.payload) as { html?: string; originalTextPreview?: string };
      preview = (p.originalTextPreview || p.html || "").slice(0, 60);
    } catch { /* ignore */ }
    jobMap.set(rounded, { id: job.id, preview });
  }

  // Day names — bilingual
  const enDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const faDays = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
  const dayNames = lang === "fa" ? faDays : enDays;
  const todayLabel = lang === "fa" ? "امروز" : "Today";
  const tomorrowLabel = lang === "fa" ? "فردا" : "Tomorrow";

  const views: ScheduleDayView[] = [];
  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    const date = new Date(Date.UTC(tn.y, tn.mo, tn.d + dayOffset));
    const slots = computeDaySlots(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      start,
      perDay,
    );

    const slotViews: ScheduleSlotView[] = [];
    let occupiedCount = 0;

    for (const slotEpoch of slots) {
      const rounded = Math.round(slotEpoch / 60000) * 60000;
      const job = jobMap.get(rounded);
      const occupied = !!job && slotEpoch > now;
      if (occupied) occupiedCount++;

      // Format slot time in Tehran
      const tehranDate = new Date(slotEpoch);
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: TEHRAN_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const timeStr = fmt.format(tehranDate);

      slotViews.push({
        time: timeStr,
        epoch: slotEpoch,
        occupied,
        postPreview: job?.preview,
        jobId: job?.id,
      });
    }

    // Day label (bilingual)
    const tehranDate = new Date(Date.UTC(tn.y, tn.mo, tn.d + dayOffset));
    const dayOfWeek = new Intl.DateTimeFormat("en-GB", {
      timeZone: TEHRAN_TZ,
      weekday: "short",
    }).format(tehranDate);
    const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayOfWeek);
    const dayName = dayIdx >= 0 ? dayNames[dayIdx] : dayOfWeek;

    let dayLabel: string;
    if (dayOffset === 0) dayLabel = `📅 ${todayLabel} (${dayName})`;
    else if (dayOffset === 1) dayLabel = `📅 ${tomorrowLabel} (${dayName})`;
    else dayLabel = `📅 ${dayName}`;

    // Date key for sorting
    const dateKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: TEHRAN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(tehranDate);

    views.push({
      dayLabel,
      dateKey,
      slots: slotViews,
      occupiedCount,
    });
  }

  return views;
}
