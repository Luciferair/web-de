# 🕷️ Website Cloner — Scraper

A powerful Bun/TypeScript script that **clones any website** to a local folder — HTML, CSS, JS, images, fonts — so the page looks identical offline.

Supports **3 modes**:

| Mode | Use Case |
|------|----------|
| **Static** (default) | Regular HTML/server-rendered sites |
| **Dynamic** (`--dynamic`) | React / Vue / Angular / JS-rendered SPAs |
| **Protected** (`--dynamic --cookies` / `--login`) | Login-protected dashboards, Cloudflare pages |

---


## Quick Start

```powershell
# Install dependencies (first time only)
bun install
npx playwright install chromium

# Scrape a static site
bun run index.ts https://example.com ./output

# Scrape a dynamic site (React/Vue/Angular)
bun run index.ts https://quotes.toscrape.com/js ./output --dynamic

# Scrape a protected page with saved cookies
bun run index.ts https://my-dashboard.com ./output --dynamic --cookies cookies.json

# Scrape with auto login
bun run index.ts https://site.com ./output --dynamic \
  --login '{"url":"https://site.com/login","user":"me@x.com","pass":"secret","userField":"#email","passField":"#password","submitBtn":"button[type=submit]"}'

# Scrape — open browser and log in yourself
bun run index.ts https://site.com ./output --dynamic --manual-login
```

---

## All Options

```
bun run index.ts <URL> [output-dir] [options]

  --dynamic              Use headless Chromium (required for JS-rendered pages)
  --cookies <file.json>  Inject browser cookies from a JSON file
  --login <json>         Auto-fill a login form (JSON string)
  --manual-login         Open visible browser — log in yourself, then press ENTER
  --wait <ms>            Extra wait after page load (default: 1500ms)
```

---

## How Cookies Work (Protected Pages)

1. In Chrome/Firefox, install the **"Cookie-Editor"** extension
2. Log into the target website
3. Click the extension → **Export** → **JSON**
4. Save the file as `cookies.json`
5. Run: `bun run index.ts <URL> ./output --dynamic --cookies cookies.json`

---

## Output Structure

```
output/
├── index.html              ← Self-contained page (open this in browser)
├── example.com/
│   ├── assets/
│   │   ├── style.css
│   │   └── main.js
│   └── images/
│       └── logo.png
└── cdn.example.com/        ← CDN assets mirrored here
    └── fonts/
        └── inter.woff2
```

Open `output/index.html` in any browser — it should look **exactly** like the original page.
