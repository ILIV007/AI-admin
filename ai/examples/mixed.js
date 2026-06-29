/**
 * ai/examples/mixed.js
 * Mixed content (Persian + English, multiple types).
 */

export const EXAMPLES_MIXED = `
--- Mixed Example 1 (Persian + English + GitHub) ---
INPUT:
This project is AMAZING! پروژه‌ی خیلی خفنی!
https://github.com/user/project
@devnews

OUTPUT:
A new project has been released.
https://github.com/user/project

--- Mixed Example 2 (News + Tool) ---
INPUT:
🚨 Google releases new AI tool! ابزار هوش مصنوعی جدید گوگل! This is REVOLUTIONARY!
https://github.com/google/new-tool

OUTPUT:
Google released a new AI tool.
https://github.com/google/new-tool

--- Mixed Example 3 (Tutorial + Hardware) ---
INPUT:
To build your own server first buy Raspberry Pi 5 then install Ubuntu Server then run sudo apt update its SUPER EASY!

OUTPUT:
To build your own server:

1. Buy a Raspberry Pi 5
2. Install Ubuntu Server
3. Run: sudo apt update

--- Mixed Example 4 (Long + Hype) ---
INPUT:
This is the most INCREDIBLE tool ever! It can do everything! You won't believe it! It's MIND-BLOWING! Get it now! It's FREE! AMAZING! Revolutionary! Game-changing! Epic!

OUTPUT:
A free tool with multiple features.

--- Mixed Example 5 (Persian formal → colloquial) ---
INPUT:
این ابزار برای توسعه‌دهندگان بسیار مفید می‌باشد و قابلیت‌های فراوانی را ارائه می‌نماید.

OUTPUT:
این ابزار برای توسعه‌دهندگان مفیده و قابلیت‌های زیادی داره.

--- Mixed Example 6 (English → keep, just format) ---
INPUT:
Docker is a platform for developing shipping and running applications in containers it provides isolation portability and consistency across environments.

OUTPUT:
Docker is a platform for developing, shipping, and running applications in containers. It provides isolation, portability, and consistency across environments.

--- Mixed Example 7 (already good — minimal edit) ---
INPUT:
A new version of Python is released with performance improvements and better error messages.

OUTPUT (keep as-is):
A new version of Python is released with performance improvements and better error messages.
`;
