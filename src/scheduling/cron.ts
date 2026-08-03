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
 * Additional steps (added after initial version):
 *   2b. Recover stale "publishing" jobs (stuck >5 min) → reset to pending
 *   4b. Prune old published_posts history (>30 days)
 *   7.  Monitor DLQ depth (logs a warning if backlog grows)
 *
 * wrangler.toml registers ONE cron trigger (every 30 minutes, 48 ticks/day).
 * The scheduled() handler in index.ts calls runCron(env, ctx).
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../types";
// ExecutionContext is a global ambient type from @cloudflare/workers-types.
import { log } from "../observability/logger";
import { APPROVAL_TTL_MS } from "../config/defaults";
import {
  listPendingScheduledDue,
  listStaleApprovals,
  listStalePublishing,
  updateJobStatus,
} from "../storage/repositories/jobs";
import { setApprovalExpired } from "../storage/repositories/approval-repo";
import * as seenUpdatesRepo from "../storage/repositories/seen-updates";
import * as debugEventsRepo from "../storage/repositories/debug-events";
import { ensureOwnerExists } from "../storage/repositories/admins";
import { ensureStatsRow, GLOBAL_KEY } from "../storage/repositories/stats";
import { enqueuePublish } from "../queue/producer";
import { exec, execAll } from "../storage/d1";

// ============================================================
// Constants
// ============================================================

/** How many scheduled posts to dispatch per cron tick. */
const SCHEDULED_BATCH_SIZE = 50;

/** Retention window for seen_updates rows (7 days). */
const SEEN_UPDATES_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Keep this many debug_events rows (most recent). */
const DEBUG_EVENTS_KEEP_LAST = 500;

/** A job in 'publishing' state longer than this is considered crashed. */
const STALE_PUBLISHING_MS = 5 * 60 * 1000; // 5 minutes

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

  // ── 2b. Reset stale 'publishing' jobs (crash recovery) ────────
  // If a worker crashed after claiming a scheduled post (pending →
  // publishing) but before completing the publish, the job is stuck. Reset
  // it to 'pending' so the next cron tick re-enqueues it.
  ctx.waitUntil(
    (async () => {
      try {
        log("info", "cron.runCron", "step 2b start: reset stale publishing jobs");
        const stalePub = await listStalePublishing(env, Date.now() - STALE_PUBLISHING_MS);
        if (stalePub.length > 0) {
          log("warn", "cron.runCron", `step 2b: ${stalePub.length} stale publishing job(s)`, {
            jobIds: stalePub.map((j) => j.id),
          });
          for (const job of stalePub) {
            try {
              await updateJobStatus(env, job.id, "pending", {
                errorMessage: "auto-reset from stale 'publishing' state (crash recovery)",
              });
              // Re-enqueue for immediate publish.
              await enqueuePublish(env, job.id);
              log("info", "cron.runCron", `step 2b: reset + re-enqueued job ${job.id}`);
            } catch (e) {
              log("error", "cron.runCron", `step 2b: failed to reset job`, {
                jobId: job.id,
                error: String(e),
              });
            }
          }
        }
        log("info", "cron.runCron", "step 2b done");
      } catch (e) {
        log("error", "cron.runCron", `step 2b failed: ${String(e)}`);
      }
    })(),
  );

  // ── 3. Refresh AI model health cache (FIX-6: once per day, was every 6h) ──
  // 12 models × 2 KV ops each = 24 KV ops per refresh. Running every 30 min
  // = 48 ticks/day. Once-per-day (every 48th tick) = 1 refresh × 24 = 24 KV
  // ops/day (was 4×24=96). Also saves 36 AI calls/day (was 48, now 12).
  const healthTick = Math.floor(Date.now() / (30 * 60 * 1000));
  if (healthTick % 48 === 0) {
    ctx.waitUntil(
      (async () => {
        try {
          log("info", "cron.runCron", "step 3 start: refresh AI model health (daily)");
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
    log("info", "cron.runCron", "step 3 skipped (not daily tick)");
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

  // ── 4b. Prune old history records (FIX-5: keep last 30 days) ────
  // createHistoryRecord stores every published post as a jobs row with
  // type='approval' status='published' + is_history:true marker. Without
  // pruning, the jobs table grows unboundedly (50 posts/day × 365 = 18k/year).
  ctx.waitUntil(
    (async () => {
      try {
        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        const r = await exec(
          env.DB,
          "DELETE FROM jobs WHERE type = 'approval' AND status = 'published' AND created_at < ?",
          cutoff,
        );
        const pruned = r.meta?.changes ?? 0;
        if (pruned > 0) {
          log("info", "cron.runCron", `step 4b: pruned ${pruned} old history records`);
        }
      } catch (e) {
        log("error", "cron.runCron", `step 4b failed: ${String(e)}`);
      }
    })(),
  );

  // ── 5+6. Bootstrap (FIX-1: KV-cached for 24h, was every tick) ────
  // ensureOwnerExists + ensureStatsRow are idempotent and only need to run
  // once at first deploy. Cache the "bootstrapped" flag in KV for 24h so
  // we skip the D1 reads/writes on 47 of 48 daily cron ticks.
  ctx.waitUntil(
    (async () => {
      try {
        const cached = await env.AI_ADMIN_KV.get("boot:cron");
        if (!cached) {
          log("info", "cron.runCron", "step 5+6 start: bootstrap owner + stats");
          await ensureOwnerExists(env);
          await ensureStatsRow(env, GLOBAL_KEY);
          await env.AI_ADMIN_KV.put("boot:cron", "1", { expirationTtl: 86400 });
          log("info", "cron.runCron", "step 5+6 done (bootstrapped + cached 24h)");
        } else {
          log("info", "cron.runCron", "step 5+6 skipped (cached)");
        }
      } catch (e) {
        log("error", "cron.runCron", `step 5+6 failed: ${String(e)}`);
      }
    })(),
  );

  // ── 7. DLQ monitoring (FIX-10: log permanently failed jobs) ──────
  // Jobs that exhausted all 3 retry attempts have status='failed'. We can't
  // list the Cloudflare Queue DLQ directly, but we CAN count failed jobs in
  // D1 and warn so the admin knows to investigate.
  ctx.waitUntil(
    (async () => {
      try {
        const rows = await execAll<{ c: number }>(
          env.DB,
          "SELECT COUNT(*) as c FROM jobs WHERE status = 'failed' AND attempts >= 3",
        );
        const failedCount = rows[0]?.c ?? 0;
        if (failedCount > 0) {
          log("warn", "cron.runCron", `step 7: ${failedCount} permanently failed job(s) in D1`, { failedCount });
        }
      } catch { /* non-fatal */ }
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
