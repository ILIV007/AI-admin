/**
 * src/ai/profiles/ilivir3.ts
 *
 * The ILIVIR3 channel profile is defined CENTRALLY in
 * `src/config/defaults.ts` so that the AI layer, the pipeline, and any
 * future profile editors all read from a single source of truth. This
 * module simply re-exports it so callers can import it from the
 * `src/ai/profiles/` namespace if they prefer.
 *
 * Usage:
 *   import { ILIVIR3_PROFILE } from "../profiles/ilivir3";
 *   // or just:
 *   import { ILIVIR3_PROFILE } from "../../config/defaults";
 *
 * The profile encodes the channel's soul (identity), style (voice),
 * rules (what must be preserved / removed), and formatting conventions.
 * See `src/config/defaults.ts` for the full text.
 */

export { ILIVIR3_PROFILE } from "../../config/defaults";
