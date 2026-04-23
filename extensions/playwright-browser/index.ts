import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCodeHandle } from "../code-runner/hooks";

registerCodeHandle({
	name: "playwright",
	summary:
		"Control a browser with Playwright: launch Chromium/Firefox/WebKit, navigate pages, click or fill elements, take screenshots, and execute JavaScript in the page context.",
	keywords: [
		"browser",
		"playwright",
		"chromium",
		"firefox",
		"webkit",
		"automation",
		"ui",
		"e2e",
		"page",
		"dom",
		"javascript",
		"evaluate",
		"screenshot",
		"scrape",
		"login",
		"click",
		"form",
		"headless",
		"website",
		"webapp",
	],
	setupCode: `
import * as pw from "playwright";

const browserTypes = {
  chromium: pw.chromium,
  firefox: pw.firefox,
  webkit: pw.webkit,
};

async function launch(options = {}) {
  const { kind = "chromium", ...launchOptions } = options ?? {};
  const browserType = browserTypes[kind];
  if (!browserType) {
    throw new Error(\`Unknown browser kind: \${String(kind)}. Use chromium, firefox, or webkit.\`);
  }
  return browserType.launch(launchOptions);
}

async function openPage(url, options = {}) {
  const {
    kind = "chromium",
    launchOptions = {},
    contextOptions = {},
    pageOptions = {},
    gotoOptions = {},
  } = options ?? {};

  const browser = await launch({ kind, ...launchOptions });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  if (pageOptions.viewportSize) {
    await page.setViewportSize(pageOptions.viewportSize);
  }
  if (pageOptions.defaultTimeout != null) {
    page.setDefaultTimeout(pageOptions.defaultTimeout);
  }
  if (pageOptions.defaultNavigationTimeout != null) {
    page.setDefaultNavigationTimeout(pageOptions.defaultNavigationTimeout);
  }
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", ...gotoOptions });
  }

  return { browser, context, page };
}

async function withBrowser(fn, options = {}) {
  const { kind = "chromium", launchOptions = {}, contextOptions = {} } = options ?? {};
  const browser = await launch({ kind, ...launchOptions });
  const context = await browser.newContext(contextOptions);
  try {
    return await fn({ browser, context });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function withPage(url, fn, options = {}) {
  const session = await openPage(url, options);
  try {
    return await fn(session);
  } finally {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }
}

const playwright = {
  ...pw,
  launch,
  openPage,
  withBrowser,
  withPage,
};
`.trim(),
	docs: `
## \`playwright\` — Browser automation & in-page JavaScript execution

Pre-initialized Playwright handle for controlling a real browser from \`exec_code\`.
It includes the standard Playwright exports (\`chromium\`, \`firefox\`, \`webkit\`, \`devices\`, \`request\`, etc.) plus convenience helpers:

- \`await playwright.launch({ kind, ...launchOptions })\`
- \`await playwright.openPage(url, { kind, launchOptions, contextOptions, pageOptions, gotoOptions })\`
- \`await playwright.withBrowser(async ({ browser, context }) => { ... }, options)\`
- \`await playwright.withPage(url, async ({ page, context, browser }) => { ... }, options)\`

Playwright-managed browsers can be installed once and reused across sessions from the shared cache.
For Chromium, install with:

\`\`\`bash
npx playwright install chromium
\`\`\`

Or install all engines:

\`\`\`bash
npx playwright install
\`\`\`

### Open a page and read DOM content

\`\`\`typescript
const result = await playwright.withPage("https://example.com", async ({ page }) => {
  await page.waitForLoadState("networkidle");
  return {
    title: await page.title(),
    heading: await page.locator("h1").textContent(),
    text: await page.locator("body").innerText(),
  };
});

console.log(result.title);
console.log(result.heading);
console.log(result.text.slice(0, 500));
\`\`\`

### Execute JavaScript in the page context

\`\`\`typescript
const pageInfo = await playwright.withPage("https://example.com", async ({ page }) => {
  return await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    links: [...document.querySelectorAll("a")].slice(0, 5).map((a) => ({
      text: a.textContent?.trim(),
      href: a.href,
    })),
    userAgent: navigator.userAgent,
  }));
});

console.log(JSON.stringify(pageInfo, null, 2));
\`\`\`

### Click, fill forms, and submit

\`\`\`typescript
await playwright.withPage("https://httpbin.org/forms/post", async ({ page }) => {
  await page.getByLabel("Custname").fill("Pi Agent");
  await page.getByLabel("Custtel").fill("123456789");
  await page.getByLabel("Custemail").fill("pi@example.com");
  await page.getByRole("button", { name: /submit/i }).click();
  await page.waitForLoadState("networkidle");
  console.log(await page.locator("body").innerText());
});
\`\`\`

### Keep the browser/page open manually

\`\`\`typescript
const { browser, context, page } = await playwright.openPage("https://example.com", {
  kind: "chromium",
  launchOptions: { headless: true },
  contextOptions: { viewport: { width: 1440, height: 900 } },
});

try {
  console.log(await page.title());
  await page.screenshot({ path: "example.png", fullPage: true });
  const html = await page.content();
  console.log(html.slice(0, 1000));
} finally {
  await context.close();
  await browser.close();
}
\`\`\`

### Capture console output from the page

\`\`\`typescript
await playwright.withPage("https://example.com", async ({ page }) => {
  page.on("console", (msg) => {
    console.log(\`[browser:\${msg.type()}] \${msg.text()}\`);
  });

  await page.evaluate(() => {
    console.log("Hello from the browser page");
    console.log(document.title);
  });
});
\`\`\`

### Use raw Playwright APIs directly

\`\`\`typescript
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
\`\`\`
`.trim(),
});

export default function (_pi: ExtensionAPI) {}
