/**
 * ai/examples/long_posts.js
 */

export const EXAMPLES_LONG_POSTS = `
--- Long Post Example 1 ---
INPUT (very long, 15 sentences run together):
Cloudflare Workers is a serverless platform that runs JavaScript at the edge. It allows developers to deploy code globally without managing servers. The platform supports multiple languages including JavaScript Rust C and C++. Workers run in over 300 cities worldwide providing low latency for users everywhere. The free tier includes 100000 requests per day which is enough for most small projects. Workers can be combined with other Cloudflare services like KV Durable Objects and R2. The platform also supports scheduled tasks via Cron Triggers. Developers can deploy using Wrangler CLI or the Cloudflare dashboard. Workers support environment variables and secrets for configuration. The platform integrates well with popular frameworks like Hono and Remix.

OUTPUT (split into paragraphs, preserve meaning):
Cloudflare Workers is a serverless platform that runs JavaScript at the edge. It allows developers to deploy code globally without managing servers.

The platform supports multiple languages including JavaScript, Rust, C, and C++. Workers run in over 300 cities worldwide, providing low latency for users everywhere.

The free tier includes 100,000 requests per day, which is enough for most small projects. Workers can be combined with other Cloudflare services like KV, Durable Objects, and R2.

The platform also supports scheduled tasks via Cron Triggers. Developers can deploy using Wrangler CLI or the Cloudflare dashboard. Workers support environment variables and secrets for configuration, and integrate well with popular frameworks like Hono and Remix.

--- Long Post Example 2 ---
INPUT (long Persian text):
در دنیای امروز هوش مصنوعی نقش بسیار مهمی ایفا می‌کند و بسیاری از شرکت‌ها در حال سرمایه‌گذاری روی این فناوری هستند. مدل‌های زبانی بزرگ مثل GPT و Gemini توانسته‌ند تحولی عظیم در زمینه پردازش زبان طبیعی ایجاد کنند. این مدل‌ها می‌توانند متن بنویسند کد تولید کنند و حتی تصاویر را توصیف کنند. با این حال چالش‌هایی هم وجود دارد مانند مصرف بالای انرژی و مسائل اخلاقی. محققان در تلاشند تا مدل‌های کوچکتر و کارآمدتری بسازند که بتوانند روی دستگاه‌های موبایل هم اجرا شوند. آینده هوش مصنوعی روشن به نظر می‌رسد اما نیاز به регولاسیون مناسب دارد.

OUTPUT (split into shorter paragraphs):
در دنیای امروز هوش مصنوعی نقش بسیار مهمی ایفا می‌کند و بسیاری از شرکت‌ها در حال سرمایه‌گذاری روی این فناوری هستند.

مدل‌های زبانی بزرگ مثل GPT و Gemini توانسته‌اند تحولی عظیم در زمینه پردازش زبان طبیعی ایجاد کنند. این مدل‌ها می‌توانند متن بنویسند، کد تولید کنند و حتی تصاویر را توصیف کنند.

با این حال چالش‌هایی هم وجود دارد مانند مصرف بالای انرژی و مسائل اخلاقی. محققان در تلاشند تا مدل‌های کوچکتر و کارآمدتری بسازند که بتوانند روی دستگاه‌های موبایل هم اجرا شوند.

آینده هوش مصنوعی روشن به نظر می‌رسد اما نیاز به регولاسیون مناسب دارد.

--- Long Post Example 3 ---
INPUT (tutorial with many steps):
To set up the project first install Node.js from the official website then verify installation with node --version after that clone the repository using git clone then navigate to the project directory with cd then install dependencies using npm install then create a .env file with your configuration then run the development server using npm run dev then open your browser to localhost 3000 and you should see the app running.

OUTPUT (numbered list):
To set up the project:

1. Install Node.js from the official website
2. Verify installation with: node --version
3. Clone the repository: git clone <repo-url>
4. Navigate to the project directory: cd <project-name>
5. Install dependencies: npm install
6. Create a .env file with your configuration
7. Run the development server: npm run dev
8. Open your browser to localhost:3000
`;
