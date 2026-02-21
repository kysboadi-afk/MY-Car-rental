# SLY-RIDES
Simple car rental website — live at **[https://www.slytrans.com](https://www.slytrans.com)** 🚗

## ⚠️ Action Required — Merge the Pull Request

**The chatbot, ID upload section, and payment fixes are NOT yet live** because the code changes are sitting in an unmerged pull request.

To make all features go live at www.slytrans.com:

1. Go to **https://github.com/kysboadi-afk/SLY-RIDES/pulls**
2. Open the open pull request (it will be the most recent one)
3. Click **"Merge pull request"** → **"Confirm merge"**

That's it — within a few minutes GitHub Pages will rebuild and the site will have:
- 💬 Chatbot widget (bottom-right of every page)
- 📎 Driver's License / ID upload section on the booking form
- 💳 Fixed Pay Now button (requires dates + ID + agreement)
- 🔤 SLY Rides branding on all pages
- 📱 Fully styled booking form

---

## Domain Status

| Step | Status |
|------|--------|
| GoDaddy DNS records configured | ✅ Done |
| DNS propagated | ✅ Done |
| GitHub Pages custom domain set | ✅ Done |
| Enforce HTTPS enabled | ✅ Done |
| Pull request merged to main | ⏳ **Pending — merge now!** |

🎉 Site: **[https://www.slytrans.com](https://www.slytrans.com)**

---

### DNS Records (reference)

**A Records (GoDaddy → GitHub Pages):**

| Type | Name | Value |
|------|------|-------|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

**CNAME Record:**

| Type | Name | Value |
|------|------|-------|
| CNAME | www | your-github-pages-url.github.io |
