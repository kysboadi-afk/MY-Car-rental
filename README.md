# SLY-RIDES
Simple car rental website

## Custom Domain Setup

This site is configured to be served at **www.slytrans.com** via GitHub Pages.

**Yes — you must update GoDaddy DNS settings to make the domain work.** Follow both steps below.

---

### Step 1 — Update GoDaddy DNS ✅ (required)

Log in to your GoDaddy account → **My Products → DNS** for `slytrans.com` and add these records:

**A Records** (point the root domain to GitHub Pages):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | 185.199.108.153 | 600 |
| A | @ | 185.199.109.153 | 600 |
| A | @ | 185.199.110.153 | 600 |
| A | @ | 185.199.111.153 | 600 |

**CNAME Record** (point `www` to GitHub Pages):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| CNAME | www | your-github-pages-url.github.io | 600 |

> **Note:** For the CNAME value, use your GitHub Pages URL (e.g. `username.github.io`). This is found in your repository **Settings → Pages**.

Save the records. DNS changes can take up to 48 hours to fully propagate.

---

### Step 2 — Set custom domain in GitHub ✅ (required)

1. Go to your repository on GitHub
2. Click **Settings → Pages**
3. Under **Custom domain**, enter `www.slytrans.com` and click **Save**
4. Once DNS propagates, check **Enforce HTTPS**
