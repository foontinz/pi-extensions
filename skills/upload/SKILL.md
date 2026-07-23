---
name: upload
description: Upload HTML to PageDrop and return a public shareable URL. Use only when the user explicitly writes @upload or invokes /skill:upload; never upload automatically.
compatibility: Requires Node.js 18+.
metadata:
  provider: PageDrop
  endpoint: https://pagedrop.io/api/upload
---

# Upload HTML

Publish the HTML the user identifies; do not redesign, rewrite, or add content unless the prompt asks.

## Steps

1. Resolve the requested HTML to a local file. If the HTML exists only in the conversation, write it to a temporary `.html` file.
2. Use the TTL requested by the user: `1h`, `1d`, `3d`, or `once`. Default to `3d` when omitted.
3. Upload with Node.js so no browser-only headers are sent:

```bash
HTML_FILE="/absolute/path/to/page.html" TTL="3d" node --input-type=module <<'NODE'
import fs from "node:fs";
import https from "node:https";

const html = fs.readFileSync(process.env.HTML_FILE, "utf8");
if (!html.trim()) throw new Error("HTML file is empty");
if (Buffer.byteLength(html, "utf8") > 16 * 1024 * 1024) {
  throw new Error("HTML exceeds PageDrop's 16MB limit");
}

const payload = {
  html,
  ttl: process.env.TTL || "3d",
  visibility: "private",
};
if (process.env.FILE_NAME) payload.fileName = process.env.FILE_NAME;
if (process.env.CUSTOM_PATH) payload.customPath = process.env.CUSTOM_PATH;
if (process.env.PASSWORD) payload.password = process.env.PASSWORD;
const body = JSON.stringify(payload);

const { statusCode, responseBody } = await new Promise((resolve, reject) => {
  const request = https.request({
    hostname: "pagedrop.io",
    path: "/api/upload",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", () => resolve({
      statusCode: response.statusCode,
      responseBody: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.on("error", reject);
  request.end(body);
});

let result;
try { result = JSON.parse(responseBody); }
catch { throw new Error(`PageDrop returned HTTP ${statusCode}: ${responseBody}`); }
if (statusCode < 200 || statusCode >= 300 || !result.success) {
  const error = typeof result.error === "string"
    ? result.error
    : result.error?.message || result.error?.code || "Upload failed";
  throw new Error(`${result.code || statusCode}: ${error}`);
}
console.log(result.data.url);
NODE
```

Set optional environment variables only when requested:

- `FILE_NAME` — display filename, maximum 255 characters
- `CUSTOM_PATH` — 3–63 characters, letters/numbers/hyphens
- `PASSWORD` — password protection, maximum 128 characters

4. Return the resulting URL. Mention the TTL and password only if relevant.

## Rules

- The endpoint is `POST https://pagedrop.io/api/upload`; no API key is required.
- Keep `visibility` set to `private`. The URL is still publicly reachable, but the page is not listed in Explore.
- Never send browser headers such as `Origin` or `Sec-Fetch-*`.
- Do not upload phishing, malware, illegal, abusive, explicit, harassing, or copyright-infringing content.
- Do not open a `once` URL to verify it; the first view deletes it.
- If a custom path is unavailable, report that briefly or retry without it only when the user did not require that exact path.
