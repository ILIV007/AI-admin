export const RTL_RULES = `
═══════════════════════════════════════════════
RTL RULES (Persian/Arabic typography)
═══════════════════════════════════════════════

Apply these rules when the content is in Persian/Arabic (RTL languages):

SPACING:
- Empty line between heading and text
- NO empty line between bullet items (keep them compact)
- Empty line after a quote block
- Empty line after a link
- Empty line between paragraphs

PARAGRAPHS:
- Max 4 lines per paragraph
- One idea per paragraph

LISTS:
- Use • (bullet) for unordered lists
- Use ۱️⃣ ۲️⃣ ۳️⃣ (Persian number emojis) for numbered steps when possible
- Or use ۱. ۲. ۳. (Persian digits) as alternative

PUNCTUATION:
- Use Persian comma (،) not English comma (,)
- Use Persian question mark (؟) not English (?)
- Use Persian semicolon (؛) where appropriate
- Fix spacing around parentheses: (متن) not ( متن )
- Use half-spaces (نیم‌فاصله) for compound words: کتاب‌خانه not کتاب خانه

NUMBERS:
- Prefer Persian digits (۱۲۳۴۵۶۷۸۹۰) in Persian text
- Keep English digits for: version numbers, code, URLs, technical specs

HEADING STYLE:
- Add a functional emoji before headings:
  ✨ ویژگی‌ها
  📦 نصب
  💡 نکته
  ⚠️ هشدار
  🛠️ ابزار

BULLET STYLE:
• مورد اول
• مورد دوم
• مورد سوم
(keep bullets on consecutive lines, no empty line between them)

NEVER:
- Mix RTL and LTR direction incorrectly
- Put English punctuation in Persian text
- Break Persian words with spaces (use half-spaces)
- Use English comma in Persian sentences
═══════════════════════════════════════════════
`.trim();
