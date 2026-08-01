/**
 * src/processing/preservation.ts
 * -----------------------------------------------------------------------------
 * Validate that the AI rewrite did NOT destroy technical content.
 *
 * We check four classes of "must-survive" content:
 *
 *   1. URLs        — every URL in the original must appear in the rewrite
 *                    (verbatim, or in a recognizable transformation such as
 *                    http↔https, trailing-slash variation, or markdown-link
 *                    wrapping).
 *   2. GitHub repos — `owner/repo` from github.com/owner/repo must appear.
 *   3. Code fences  — if the original had N code blocks, the rewrite must
 *                    have ≥ N−1 (allowing minor merges).
 *   4. Package names — tokens mentioned in `npm install X` / `pip install X`
 *                    must appear.
 *
 * ok=false if ANY of the above is missing. The pipeline then decides whether
 * to fall back to the cleaned original (critical URL/repo loss) or keep the
 * AI output with a warning (minor losses).
 * -----------------------------------------------------------------------------
 */

export interface PreservationResult {
  ok: boolean;
  missing: string[];
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

// FIX: also detect bare URLs without protocol (example.com, github.com/owner/repo)
// These are common in user input and AI output — must be preserved.
const URL_RE = /(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"')]*)?/gi;

const GITHUB_REPO_RE =
  /(?:github\.com|gist\.github\.com|raw\.githubusercontent\.com)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)/gi;

const NPM_PKG_RE = /(?:npm\s+install(?:\s+-g)?|npm\s+i)\s+([A-Za-z0-9_@./-]+)/gi;
const PIP_PKG_RE = /pip\s+install\s+([A-Za-z0-9_.-]+)/gi;

const CODE_FENCE_RE = /```/g;

// ---------------------------------------------------------------------------
// validatePreservation
// ---------------------------------------------------------------------------

export function validatePreservation(
  original: string,
  rewritten: string,
): PreservationResult {
  const missing: string[] = [];
  const rewrittenLower = rewritten.toLowerCase();

  // --- URLs ---
  const origUrls = extractUrls(original);
  for (const url of origUrls) {
    if (!rewritten.includes(url)) {
      if (!isUrlTransformed(url, rewritten, rewrittenLower)) {
        missing.push(`url:${url}`);
      }
    }
  }

  // --- GitHub repos (owner/repo) ---
  const origRepos = extractGithubRepos(original);
  for (const repo of origRepos) {
    if (!rewrittenLower.includes(repo.toLowerCase())) {
      missing.push(`repo:${repo}`);
    }
  }

  // --- Code fences count ---
  const origFences = countCodeFences(original);
  const newFences = countCodeFences(rewritten);
  if (newFences < origFences - 1) {
    missing.push(`codeblocks:had ${origFences}, now ${newFences}`);
  }

  // --- Package names ---
  const origPackages = extractPackages(original);
  for (const pkg of origPackages) {
    if (!rewritten.includes(pkg)) {
      missing.push(`pkg:${pkg}`);
    }
  }

  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) || [];
  // Strip trailing punctuation that's almost certainly not part of the URL.
  // (Helps when the URL ends a sentence: "...see https://x.com/page.")
  return Array.from(
    new Set(matches.map((u) => u.replace(/[.,;:!?)\]]+$/, ""))),
  );
}

function extractGithubRepos(text: string): string[] {
  const repos = new Set<string>();
  const re = new RegExp(GITHUB_REPO_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const owner = m[1];
    const repo = m[2];
    if (!owner || !repo) continue;
    // Skip obvious non-repo path segments.
    const lower = repo.toLowerCase();
    if (
      lower === "favicon.ico" ||
      lower === "robots.txt" ||
      lower === "archive" ||
      lower === "releases" ||
      lower === "issues" ||
      lower === "pulls" ||
      lower === "wiki" ||
      lower === "blob" ||
      lower === "tree" ||
      lower === "raw"
    ) {
      continue;
    }
    repos.add(`${owner}/${repo}`);
  }
  return Array.from(repos);
}

function countCodeFences(text: string): number {
  const matches = text.match(CODE_FENCE_RE) || [];
  return Math.floor(matches.length / 2);
}

function extractPackages(text: string): string[] {
  const packages = new Set<string>();
  const npmRe = new RegExp(NPM_PKG_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = npmRe.exec(text)) !== null) {
    if (m[1]) packages.add(m[1]);
  }
  const pipRe = new RegExp(PIP_PKG_RE.source, "gi");
  while ((m = pipRe.exec(text)) !== null) {
    if (m[1]) packages.add(m[1]);
  }
  return Array.from(packages);
}

// ---------------------------------------------------------------------------
// URL transformation matcher
// ---------------------------------------------------------------------------

/**
 * Recognize whether `url` appears in `rewritten` in any of these forms:
 *   • verbatim
 *   • wrapped in a markdown link [text](url)
 *   • with http ↔ https swapped
 *   • with trailing slash added/removed
 *   • with whitespace inserted by line-wrapping (compacted back out)
 */
function isUrlTransformed(
  url: string,
  rewritten: string,
  rewrittenLower: string,
): boolean {
  if (rewritten.includes(url)) return true;

  const normalized = url
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();

  if (rewrittenLower.includes(normalized)) return true;

  // Line-wrapped form: "https://example.\ncom/page" → "https://example.com/page"
  const compact = rewrittenLower.replace(/\s+/g, "");
  if (compact.includes(normalized)) return true;

  // Markdown-link wrapped form: [text](url)
  if (rewrittenLower.includes(`](${url.toLowerCase()}`)) return true;
  if (rewrittenLower.includes(`](${normalized}`)) return true;

  return false;
}
