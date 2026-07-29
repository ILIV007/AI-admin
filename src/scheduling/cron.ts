/**
 * src/scheduling/cron.ts
 * -----------------------------------------------------------------------------
 * THE single cron trigger.
 *
 * CRITICAL CONSTRAINT: the user said ONLY ONE cron trigger is allowed. This
 * function does ALL of:
 *   1. Publish scheduled posts due now (enqueue publish_scheduled messages).
 *      This includes the scheduled_post jobs created by the schedule system
 *      (task 26): when `settings.scheduleEnabled === true`, the pipeline
 *      stores formatted posts in D1 with a `scheduled_for` epoch ms. This
 *      step fans them out to the queue once they're due; the queue
 *      consumer's `handlePublishScheduled` does the actual publish +
 *      marks the job `published`.
 *   2. Expire stale approvals (> APPROVAL_TTL_MS old)
 *   3. Refresh AI model health cache
 *   4. Prune old debug_events + seen_updates
 *   5. Ensure owner row exists (defensive — in case webhook hasn't run yet)
 *   6. Aggregate stats (ensure the global stats row exists; V2 stats are
 *      atomic so there's no batch to flush — this is a no-op most invocations)
 *
 * All steps run concurrently via ctx.waitUntil; each is wrapped in its own
 * try/catch so a failure in one step never aborts the others. Each step logs
 * start + finish so we can see timing in `wrangler tail`.
 *
 * wrangler.toml will register ONE cron trigger (every minute) that calls
 * runCron(env, ctx) from the Worker's scheduled() handler.
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../types";
// ExecutionContext is a global ambient type from @cloudflare/workers-types.
import { log } from "../observability/logger";
import { APPROVAL_TTL_MS } from "../config/defaults";
import {
  listPendingScheduledDue,
  listStaleApprovals,
} from "../storage/repositories/jobs";
import { setApprovalExpired } from "../storage/repositories/approval-repo";
import * as seenUpdatesRepo from "../storage/repositories/seen-updates";
import * as debugEventsRepo from "../storage/repositories/debug-events";
import { ensureOwnerExists } from "../storage/repositories/admins";
import { ensureStatsRow, GLOBAL_KEY } from "../storage/repositories/stats";
import { enqueuePublish } from "../queue/producer";

// ============================================================
// Constants
// ============================================================

/** How many scheduled posts to dispatch per cron tick. */
const SCHEDULED_BATCH_SIZE = 20;

/** Retention window for seen_updates rows (7 days). */
const SEEN_UPDATES_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Keep this many debug_events rows (most recent). */
const DEBUG_EVENTS_KEEP_LAST = 500;

// ============================================================
// runCron — the one and only cron entry point
// ============================================================

export async function runCron(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  log("info", "cron.runCron", "starting");

  // ── 1. Publish scheduled posts due now ──────────────────────────
  try {
    log("info", "cron.runCron", "step 1 start: publish scheduled posts due");
    const due = await listPendingScheduledDue(env, Date.now(), SCHEDULED_BATCH_SIZE);
    log("info", "cron.runCron", `step 1: ${due.length} due job(s)`, {
      count: due.length,
      jobIds: due.map((j) => j.id),
    });
    for (const job of due) {
      try {
        log("info", "cron.runCron", `step 1: enqueueing job ${job.id}`, {
          jobId: job.id,
          scheduledFor: job.scheduledFor,
          status: job.status,
        });
        await enqueuePublish(env, job.id);
        log("info", "cron.runCron", `step 1: enqueued job ${job.id} successfully`);
      } catch (e) {
        log("error", "cron.runCron", `step 1: failed to enqueue job`, {
          jobId: job.id,
          error: String(e),
        });
      }
    }
    log("info", "cron.runCron", "step 1 done");
  } catch (e) {
    log("error", "cron.runCron", `step 1 failed: ${String(e)}`);
  }

  // ── 2. Expire stale approvals ───────────────────────────────────
  ctx.waitUntil(
    (async () => {
      try {
        log("info", "cron.runCron", "step 2 start: expire stale approvals");
        const stale = await listStaleApprovals(env, Date.now() - APPROVAL_TTL_MS);
        log("info", "cron.runCron", `step 2: ${stale.length} stale approval(s)`, {
          count: stale.length,
        });
        for (const job of stale) {
          ctx.waitUntil(
            (async () => {
              await setApprovalExpired(env, job.id);
              // Best-effort notify the admin that their approval timed out.
              try {
                const clientMod = await import("../telegram/client");
                await clientMod.sendMessage(env.BOT_TOKEN, {
                  chat_id: job.userId,
                  text:
                    `⏰ <b>Approval expired</b>\n` +
                    `Job <code>${escapeHtml(job.id)}</code> was pending for more than ` +
                    `${Math.round(APPROVAL_TTL_MS / 60_000)} minutes and has been expired automatically.`,
                  parse_mode: "HTML",
                });
              } catch (e) {
                log("warn", "cron.runCron", `step 2: notify admin failed`, {
                  jobId: job.id,
                  error: String(e),
                });
              }
            })().catch((e) => {
              log("error", "cron.runCron", `step 2: expire job failed`, {
                jobId: job.id,
                error: String(e),
              });
            }),
          );
        }
        log("info", "cron.runCron", "step 2 done");
      } catch (e) {
        log("error", "cron.runCron", `step 2 failed: ${String(e)}`);
      }
    })(),
  );

  // ── 3. Refresh AI model health cache (only every 12th cron tick = once per 6 hours) ──
  // 12 models × 2 KV ops each = 24 KV ops per refresh. Running every 30 min
  // would be 8 cron ticks/day × 24 = 192 KV ops/day just for health.
  // Running once per hour (every 2nd tick) = 4 ticks × 24 = 96 KV ops/day (50% reduction).
  const healthTick = Math.floor(Date.now() / (30 * 60 * 1000));
  if (healthTick % 12 === 0) {
    ctx.waitUntil(
      (async () => {
        try {
          log("info", "cron.runCron", "step 3 start: refresh AI model health (hourly)");
          const mod: {
            refreshModelHealth: (env: Env) => Promise<void>;
          } = await import("../ai/fallback");
          await mod.refreshModelHealth(env);
          log("info", "cron.runCron", "step 3 done");
        } catch (e) {
          log("error", "cron.runCron", `step 3 failed: ${String(e)}`);
        }
      })(),
    );
  } else {
    log("info", "cron.runCron", "step 3 skipped (not hourly tick)");
  }

  // ── 4. Prune old debug_events + seen_updates ────────────────────
  ctx.waitUntil(
    (async () => {
      try {
        log("info", "cron.runCron", "step 4 start: prune old data");
        const seenPruned = await seenUpdatesRepo.pruneOld(
          env,
          SEEN_UPDATES_RETENTION_MS,
        );
        const debugPruned = await debugEventsRepo.pruneOld(
          env,
          DEBUG_EVENTS_KEEP_LAST,
        );
        log("info", "cron.runCron", "step 4 done", {
          seenUpdatesPruned: seenPruned,
          debugEventsPruned: debugPruned,
        });
      } catch (e) {
        log("error", "cron.runCron", `step 4 failed: ${String(e)}`);
      }
    })(),
  );

  // ── 5. Ensure owner exists (defensive boot) ─────────────────────
  ctx.waitUntil(
    (async () => {
      try {
        log("info", "cron.runCron", "step 5 start: ensure owner exists");
        await ensureOwnerExists(env);
        log("info", "cron.runCron", "step 5 done");
      } catch (e) {
        log("error", "cron.runCron", `step 5 failed: ${String(e)}`);
      }
    })(),
  );

  // ── 6. Aggregate stats (defensive) ──────────────────────────────
  // V2 stats are atomic per-event UPDATEs (no batch buffer), so there is no
  // "flush" to do here. We ensure the global stats row exists so the
  // dashboard never reads an empty row on first deploy.
  ctx.waitUntil(
    (async () => {
      try {
        log("info", "cron.runCron", "step 6 start: aggregate stats");
        await ensureStatsRow(env, GLOBAL_KEY);
        log("info", "cron.runCron", "step 6 done");
      } catch (e) {
        log("error", "cron.runCron", `step 6 failed: ${String(e)}`);
      }
    })(),
  );

  log("info", "cron.runCron", "all steps dispatched");
}

// ============================================================
// Helpers
// ============================================================

/** Minimal HTML escaper for the cron's admin-notification messages. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
