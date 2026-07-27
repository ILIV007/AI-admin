/**
 * src/queue/producer.ts
 * -----------------------------------------------------------------------------
 * Queue producer helpers.
 *
 * Every webhook update that passes dedup is enqueued via `enqueueUpdate`.
 * The actual processing happens in `consumer.ts` — this split is the fix for
 * V1 bug #2 ("ctx.waitUntil for 90s pipeline is unreliable"): the webhook
 * returns 200 in <50ms and the queue consumer does the heavy work outside the
 * request lifetime, with automatic retries on transient failures.
 *
 * `enqueueMediaGroupFinalize` uses Cloudflare Queues' `delaySeconds` option
 * to schedule the finalize check MEDIA_GROUP_WINDOW_MS into the future. The
 * queue runtime guarantees the message will not be delivered before the
 * delay elapses.
 * -----------------------------------------------------------------------------
 */

import type { Env, TelegramUpdate } from "../types";

/**
 * Enqueue a regular update for processing. `receivedAt` is captured at enqueue
 * time so the consumer can measure end-to-end latency even if the message
 * sits in the queue for a while (e.g. during backlog).
 */
export async function enqueueUpdate(
  env: Env,
  update: TelegramUpdate,
): Promise<void> {
  await env.QUEUE.send({
    kind: "process_update",
    update,
    receivedAt: Date.now(),
  });
}

/**
 * Enqueue a `finalize_media_group` check, delayed by `delayMs`. Cloudflare
 * Queues accept `delaySeconds` (integer seconds); we round up and enforce a
 * minimum of 1 second so very small delays still produce a real delay.
 */
export async function enqueueMediaGroupFinalize(
  env: Env,
  mediaGroupId: string,
  delayMs: number,
): Promise<void> {
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  await env.QUEUE.send(
    { kind: "finalize_media_group", mediaGroupId, receivedAt: Date.now() },
    { delaySeconds },
  );
}

/**
 * Enqueue a `publish_scheduled` message. Used by the cron to fan out
 * scheduled-post publishing to the queue (so the cron stays fast — it just
 * enqueues, the consumer does the actual publish).
 */
export async function enqueuePublish(env: Env, jobId: string): Promise<void> {
  await env.QUEUE.send({ kind: "publish_scheduled", jobId });
}
