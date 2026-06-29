#!/bin/bash
# Generates a single markdown file with ALL project code + structure + explanations

OUTPUT="/home/z/my-project/download/ai-admin-v0.4.3-full-code.md"
BASE="/home/z/my-project/download/ai-admin"

cat > "$OUTPUT" << 'HEADER'
# AI Admin — Complete Project Source Code

**Version:** 0.4.3
**Date:** 2025-06-29

This file contains the COMPLETE source code of the AI Admin Telegram bot, including all JavaScript files, configuration, and documentation.

---

## Project Structure

```
ai-admin/
├── src/                    # Core application code
│   ├── index.js           # Entry point + pipeline (901 lines)
│   ├── telegram.js         # Telegram Bot API client
│   ├── ai.js              # AI provider management (Gemini + OpenRouter)
│   ├── admin.js           # Admin panel with inline buttons
│   ├── formatter.js       # UI Formatter (HTML generation)
│   ├── cleaner.js         # Content cleaner (spam/ad removal)
│   ├── classifier.js      # Rule-based content classifier
│   ├── kv.js              # Cloudflare KV storage helpers
│   ├── prompts.js         # AI system prompts
│   └── debug.js           # Debug dashboard + logging
├── ai/                     # AI Knowledge Base
│   ├── index.js           # Knowledge base loader
│   ├── profiles/          # Profile system
│   │   ├── index.js       # Profile registry
│   │   └── ilivir3/       # ILIVIR3 profile
│   │       ├── soul.js    # Personality & identity
│   │       ├── style.js   # Writing style
│   │       └── rules.js   # Inviolable rules
│   ├── examples/          # Before/After examples
│   │   ├── github.js
│   │   ├── news.js
│   │   ├── tutorials.js
│   │   ├── tools.js
│   │   ├── hardware.js
│   │   ├── cybersecurity.js
│   │   ├── ai.js
│   │   ├── long_posts.js
│   │   └── mixed.js
│   └── *.js               # Knowledge base rules (17 files)
├── wrangler.toml           # Cloudflare Worker config
├── package.json
└── VERSION
```

## Architecture Overview

```
Telegram Update
    ↓
Stage 0: Input Parser (telegram.js) — extract text, media, entities
    ↓
Stage 1: Content Analyzer (classifier.js) — rule-based, no AI
    ↓
Stage 2: Content Editor (ai.js) — AI rewrite (PLAIN TEXT output)
    ↓
Stage 3: UI Formatter (formatter.js) — HTML generation
    ↓
Stage 4: Quality Controller — truncation, validation
    ↓
Stage 5: Telegram Publisher (telegram.js) — publish to channel
```

**Golden Rule:** Editing changes words. Formatting changes appearance. Never mix them.

- `rewrite_mode` controls HOW MUCH text is rewritten
- `edit_intensity` controls ONLY UI formatting (independent of rewrite)
- Profile system (Soul + Style + Rules) can replace individual settings

## AI Provider Strategy

All providers race in parallel via `Promise.any`. First success wins.

- **Gemini:** 3 models (gemini-2.5-flash, flash-lite, 2.0-flash)
- **OpenRouter:** 11 free models (nemotron-nano fastest at 737ms)
- **Timeout:** 15s per model, 90s total pipeline
- **Fallback:** AI fail → format-only mode → plain text → never drop

---

HEADER

# Add each file
for f in $(find "$BASE/src" "$BASE/ai" -name "*.js" -not -path "*/node_modules/*" | sort); do
  relpath="${f#$BASE/}"
  echo "" >> "$OUTPUT"
  echo "---" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo "## \`$relpath\`" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo '```javascript' >> "$OUTPUT"
  cat "$f" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo '```' >> "$OUTPUT"
done

# Add config files
for f in "$BASE/wrangler.toml" "$BASE/package.json" "$BASE/VERSION"; do
  relpath="${f#$BASE/}"
  echo "" >> "$OUTPUT"
  echo "---" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo "## \`$relpath\`" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo '```' >> "$OUTPUT"
  cat "$f" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
  echo '```' >> "$OUTPUT"
done

echo "" >> "$OUTPUT"
echo "---" >> "$OUTPUT"
echo "" >> "$OUTPUT"
echo "## End of Source Code" >> "$OUTPUT"
echo "" >> "$OUTPUT"
echo "Total files: $(find "$BASE/src" "$BASE/ai" -name "*.js" | wc -l) JavaScript files" >> "$OUTPUT"
echo "Total lines: $(find "$BASE/src" "$BASE/ai" -name "*.js" -exec cat {} + | wc -l) lines" >> "$OUTPUT"

echo "Done: $OUTPUT"
wc -l "$OUTPUT"
