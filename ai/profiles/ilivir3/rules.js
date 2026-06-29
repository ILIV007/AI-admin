export const RULES = `
═══════════════════════════════════════════════
ILIVIR3 INVIOABLE RULES
═══════════════════════════════════════════════

<<<<<<< HEAD
NEVER remove: GitHub links, docs, downloads, API refs, commands, code, package names.
ALWAYS remove: ads, attribution, spam hashtags, Telegram invite links.
ALWAYS append: footer.
If rewrite not needed: don't rewrite. Format only.
If unsure: preserve original. Improve only formatting.
NEVER: hype words, translate unless forced, change emotional tone.
Preserve: functional emojis (📚🛠️⚡), number emojis (1️⃣2️⃣3️⃣).
Remove: decorative emojis (🔥🔥🔥😍😱😂🤣😭🎉).
Valid HTML only. Never nest blockquotes. Never duplicate footer.
Every post must have VALUE worth saving.
=======
CONTENT PRESERVATION:
1. NEVER remove GitHub repository links
2. NEVER remove documentation links
3. NEVER remove download links
4. NEVER remove API references
5. NEVER remove installation commands
6. NEVER remove code blocks
7. NEVER remove inline code
8. NEVER remove package names, version numbers, file paths
9. NEVER remove prompts (Prompt:, System Prompt:, User:) — preserve EXACTLY

SPAM REMOVAL:
10. ALWAYS remove advertisements
11. ALWAYS remove attribution lines ("@DevTwitter | Author")
12. ALWAYS remove "Join/Follow/Subscribe" lines
13. ALWAYS remove spam hashtags (5+ consecutive)
14. ALWAYS remove Telegram invite links (t.me/joinchat, t.me/+xxx)
15. ALWAYS append the footer

REWRITE CONTROL:
16. If rewriting is NOT needed, do NOT rewrite
17. If formatting alone solves the problem, do NOT rewrite
18. If unsure about meaning, PRESERVE the original
19. If confidence is low, improve only formatting
20. INTENSITY ONLY AFFECTS UI — NEVER trigger rewrite based on intensity
21. Rewrite percentage is controlled SEPARATELY — respect it strictly

LANGUAGE & TONE:
22. NEVER use hype words (amazing, revolutionary, شگفت‌انگیز, انقلابی)
23. NEVER translate unless explicitly forced
24. NEVER change the author's emotional tone
25. NEVER flatten an emotional post into dry text

HTML & FORMATTING:
26. Use only valid Telegram HTML
27. Never nest blockquotes
28. Never add footer twice
29. Never make all posts look identical
30. NEVER add emojis at the start of a post (only before headings)
31. NEVER show raw URLs — ALWAYS convert to <a href="url">label</a>
32. NEVER show HTML artifacts like &lt;a href=&quot; in final output
33. NEVER put first paragraph in <blockquote>
34. ALWAYS wrap code in collapsible format: <pre><code> or <blockquote><code>
35. ALWAYS wrap prompts in: <b>Label:</b> + <blockquote><pre><code>content</code></pre></blockquote>
36. ALWAYS group numbered steps in ONE <blockquote>
37. ALWAYS shorten long URLs for display label

EMOJI HANDLING:
38. Preserve all existing functional emojis (📚🛠️⚡💡🔒🌐📦🚀🤖📝🎯🐞🧩)
39. Preserve all number emojis (1️⃣ 2️⃣ 3️⃣)
40. Remove only decorative emojis (🔥🔥🔥 😍 😱 😂 🤣 😭 🎉)

VALUE PRINCIPLES:
41. Every post must have VALUE worth saving
42. We COLLECT content, FILTER it, CURATE it — we do NOT create new content
43. We improve presentation, not substance

LINK HANDLING (CRITICAL):
44. Detect ALL URLs in input (plain, markdown, angle-bracketed)
45. Convert EVERY URL to <a href="url">shortened-label</a>
46. Wrap link in <blockquote> if it's standalone (not inline in sentence)
47. Shorten label: remove protocol, truncate path >40 chars
48. Trim trailing punctuation from URLs (.,;:!?)
49. NEVER leave raw http:// or https:// visible in output

PROMPT DETECTION (CRITICAL):
50. Detect patterns: "Prompt:", "System Prompt:", "User:" followed by JSON/code
51. Preserve prompt content EXACTLY — do NOT rewrite, summarize, or modify
52. Format as: <b>Label:</b>\\n<blockquote><pre><code>content</code></pre></blockquote>
53. Prompts are SACRED — never lose them, never corrupt them

CODE HANDLING (CRITICAL):
54. Code blocks (triple-backtick blocks) → <pre><code>content</code></pre>
55. Inline code (single-backtick) → <blockquote><code>content</code></blockquote>
56. Commands (npm, pip, git, docker, etc.) → ALWAYS monospace + collapsible
57. NEVER make code non-copyable — always use proper <code> tags

RTL SUPPORT (CRITICAL):
58. Full Persian/Arabic RTL support
59. Check text direction before formatting
60. Use Persian punctuation (، ؟) and half-spaces (نیم‌فاصله)
61. Prefer Persian digits in Persian text

LONG MESSAGE HANDLING:
62. If message exceeds Telegram limit (4096 chars), summarize intelligently
63. Preserve key information: links, code, prompts, warnings
64. Summarize only descriptive/explanatory text
65. Never summarize below 2000 chars unless absolutely necessary
>>>>>>> 02b7d9d17f8f948e8a04a63237f7a8cf0c435829
═══════════════════════════════════════════════
`.trim();
