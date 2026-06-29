export const HTML_RULES = `
═══════════════════════════════════════════════
HTML RULES (Telegram HTML parse mode)
═══════════════════════════════════════════════

SUPPORTED TAGS:
- <b>bold</b>
- <i>italic</i>
- <u>underline</u>
- <s>strikethrough</s>
- <code>inline code</code>
- <pre>block code</pre>
- <pre><code>code block with language</code></pre>
- <blockquote>quote</blockquote>
- <blockquote expandable>collapsible quote</blockquote>
- <a href="url">text</a>

USAGE RULES:

<b> Bold:
- ONLY for important info (tool names, product names, warnings)
- 2-6 per post
- Never bold entire paragraphs

<code> Monospace:
- For: commands, filenames, env vars, API names
- Examples: \`npm install\`, \`GEMINI_API_KEY\`, \`package.json\`

<blockquote> Quote:
- For: URLs, repos, docs, commands, footer
- NOT for decoration
- Never nest blockquotes

<blockquote expandable> Collapsible Quote:
- For: long reference text, footers, expandable content
- Modern Telegram clients support this

<pre><code> Code blocks:
- For multi-line code
- Preserve indentation
- Never modify code content

<a> Links:
- Use for inline links if needed
- But prefer putting URLs on their own line in a blockquote

FORBIDDEN:
- Nested blockquotes (<blockquote> inside <blockquote>)
- Unclosed tags
- Invalid HTML
- Markdown syntax in HTML mode (no **, no __)
- Multiple footers

TELEGRAM LIMITS:
- Text message: 4096 chars
- Caption (with media): 1024 chars
- Always stay under these limits
═══════════════════════════════════════════════
`.trim();
