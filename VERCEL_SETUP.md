# 🚀 Stripe + Vercel Setup Guide

This guide explains the current architecture and how to verify your Stripe payment form is working.

---

## How Your Site Is Structured

```
www.slytrans.com  (GitHub Pages — serves the HTML/CSS/JS frontend)
        │
        │  Pay Now click → fetch POST
        ▼
sly-rides.vercel.app  (Vercel — runs the API functions)
   └── /api/create-payment-intent   ← creates the Stripe payment
        │
        ▼
   Stripe (processes card, returns clientSecret)
        │
        ▼
Card form mounts on the booking page ✅
```

**`sly-rides.vercel.app` is correct.** That is the auto-generated Vercel URL for your project. Your frontend (on GitHub Pages) talks to that URL whenever a customer clicks Pay Now.

---

## Step 1 — Confirm Your Vercel Project Is Deployed

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)**.
2. You should see a project named **sly-rides** (or similar).
3. Its URL should show **`sly-rides.vercel.app`** — this is **correct and expected**.
4. The status should be **"Ready"** (green). If it says "Error", click the deployment to see the build log.

---

## Step 2 — Add Your Stripe API Keys in Vercel

Without these, the card form cannot load. This is the most common reason it doesn't appear.

### Get your keys from Stripe

1. Go to **[https://dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)**.
2. Copy both keys:
   - **Secret key** — starts with `sk_live_` or `sk_test_`
   - **Publishable key** — starts with `pk_live_` or `pk_test_`

> 💡 Use `sk_test_` / `pk_test_` for testing. Only switch to live keys when accepting real money.

### Add them to Vercel

1. In Vercel, open your **sly-rides** project.
2. Go to **Settings → Environment Variables**.
3. Add both variables (click **"Add New"** for each):

| Variable Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your secret key (`sk_live_…` or `sk_test_…`) |
| `STRIPE_PUBLISHABLE_KEY` | Your publishable key (`pk_live_…` or `pk_test_…`) |

4. Click **Save**.
5. Go to **Deployments** → click the **⋯** next to the latest deployment → **Redeploy**.  
   *(This is required for new env vars to take effect.)*

---

## Step 3 — Add Your Email Variables (for Reservation Notifications)

Without these, no emails are sent — not to you and not to the renter.

| Variable Name | Value |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your sending email address |
| `SMTP_PASS` | App password for that email (see below) |
| `OWNER_EMAIL` | Your **work email** — this is where booking notifications land |

> ⚠️ **`OWNER_EMAIL` must be your work email.** Every time a renter pays, the system sends you a notification at this address with the full booking details. If this is not set, notifications go to the default address `slyservices@supports-info.com`. Set it to your actual inbox.

### How to get a Gmail App Password

1. Go to **[https://myaccount.google.com/security](https://myaccount.google.com/security)**.
2. Make sure **2-Step Verification** is ON.
3. Search for **"App passwords"** → click it.
4. Choose **Mail** → **Other (Custom name)** → name it `SLY Rides`.
5. Copy the 16-character password → use it as `SMTP_PASS` in Vercel.

### Step 3a — Verify Your Email Setup (Diagnostic Endpoint)

After adding your email variables and redeploying, visit this URL in your browser to get an instant status report:

```
https://sly-rides.vercel.app/api/check-email
```

The response will tell you:
- ✅ / ❌ Whether each SMTP variable is set
- ✅ / ❌ What email address owner notifications will be sent to
- ✅ / ❌ Whether a live SMTP connection can actually be established

**Example of a healthy response:**
```json
{
  "overall": "✅ All checks passed — email notifications are correctly configured",
  "smtp": {
    "SMTP_HOST": "✅ set (smtp.gmail.com)",
    "SMTP_PORT": "✅ set (587)",
    "SMTP_USER": "✅ set",
    "SMTP_PASS": "✅ set"
  },
  "ownerEmail": {
    "value": "yourwork@email.com",
    "source": "OWNER_EMAIL env var"
  },
  "connection": {
    "status": "✅ SMTP connection to smtp.gmail.com:587 succeeded — emails can be sent"
  }
}
```

---

## Step 3b — Add Your GitHub Token (for Automatic Calendar Blocking)

When a booking is confirmed, the API automatically updates `booked-dates.json` in your GitHub repository so those dates are blocked on the calendar for future visitors. This requires a GitHub personal access token (PAT).

| Variable Name | What to put in the "Value" field in Vercel |
|---|---|
| `GITHUB_TOKEN` | The token string you generate below — it looks like `github_pat_11ABCDE…` (a long string of letters and numbers) |

> 💡 **The value is the token string itself.** You generate it once on GitHub, copy it, and paste it directly into Vercel's Value field. It is not a username, password, or URL — just that one long string.

### How to create the token and add it to Vercel

**Part A — Create the token on GitHub**

1. Go to **[https://github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)**.  
   *(You must be logged in as the owner of the `kysboadi-afk/SLY-RIDES` repository.)*
2. Give it a name, e.g. **`SLY-RIDES calendar`**.
3. Set **Expiration** to a date far in the future (e.g. 1 year) so it doesn't expire mid-season.
4. Under **Repository access**, select **Only select repositories** → choose `SLY-RIDES`.
5. Under **Permissions → Repository permissions**, find **Contents** and set it to **Read and write**.
6. Click **Generate token**.
7. **Copy the token immediately** — GitHub shows it only once. It will look like:  
   ```
   github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdefghij
   ```

**Part B — Paste it into Vercel**

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)** and open your **sly-rides** project.
2. Click **Settings → Environment Variables → Add New**.
3. Set **Name** to `GITHUB_TOKEN`.
4. Set **Value** to the token string you just copied from GitHub (the `github_pat_…` string).
5. Leave **Environment** as **Production** (or select all three if you want it in Preview/Development too).
6. Click **Save**.
7. Go to **Deployments** → click **⋯** next to the latest deployment → **Redeploy**.  
   *(New env vars only take effect after a redeploy.)*

> ⚠️ Without this token, bookings will still send confirmation emails but the calendar will **not** automatically block the reserved dates. You would need to manually edit `booked-dates.json` in the repository after each booking.

---

## Step 4 — Add Your SignNow Variables (for E-Signature)

Required for the rental agreement e-signature feature. Without these, the booking page will show an error asking the customer to contact you directly.

### Option A — OAuth Credentials (Recommended)

Using OAuth credentials is **strongly preferred** over a static token. SignNow access tokens expire after ~30–60 minutes, so a static token that was working when you added it will silently stop working later. OAuth credentials let the API fetch a fresh token on every request.

| Variable Name | Value |
|---|---|
| `SIGNNOW_CLIENT_ID` | Client ID from your SignNow API application |
| `SIGNNOW_CLIENT_SECRET` | Client secret from your SignNow API application |
| `SIGNNOW_EMAIL` | Your SignNow account email address |
| `SIGNNOW_PASSWORD` | Your SignNow account password |
| `SIGNNOW_TEMPLATE_ID` | ID of the rental agreement **template** in SignNow |

#### How to get your SignNow Client ID and Client Secret

1. Log in at **[https://app.signnow.com](https://app.signnow.com)**.
2. Go to **Apps & SDKs → API → Applications**.
3. Create a new application (or use an existing one).
4. Copy the **Client ID** and **Client Secret**.

### Option B — Static Access Token (Simple but expires)

> ⚠️ **Static tokens expire.** The token will work briefly after you generate it, but will stop working after ~30–60 minutes, causing the "couldn't send your rental agreement" error. Use Option A if you want reliable long-term operation.

| Variable Name | Value |
|---|---|
| `SIGNNOW_API_TOKEN` | Access token from your SignNow account |
| `SIGNNOW_TEMPLATE_ID` | ID of the rental agreement **template** in SignNow |

### How to find your SignNow Template ID

1. Log in at **[https://app.signnow.com](https://app.signnow.com)**.
2. Go to **Templates** and open your rental agreement template.
3. Copy the ID from the URL: `app.signnow.com/webapp/template/**{TEMPLATE_ID}**/edit`

> ⚠️ **Important — use a Template ID, not a Document ID.** Each booking automatically copies the template to create a fresh blank document for that renter. This ensures every customer signs their own private copy and can never see another renter's filled-in data. If you accidentally set this to a filled document ID, renters will see each other's contracts.

### Optional: Custom Role Name

If your SignNow template uses a role name other than **"Signer 1"** (e.g. "Customer", "Tenant", "Renter"), add this variable:

| Variable Name | Value |
|---|---|
| `SIGNNOW_ROLE_NAME` | The exact role name from your SignNow template (default: `Signer 1`) |

> 💡 To find your template's role name: open the template in SignNow → click **Edit** → look at the role/field assignments on the right side panel.

---

## Step 5 — Verify Your SignNow Setup (Diagnostic Endpoint)

After adding your SignNow environment variables and redeploying, visit this URL in your browser to get an instant status report:

```
https://sly-rides.vercel.app/api/check-signnow
```

The response will tell you:
- ✅ / ❌ Whether authentication is working (OAuth or static token)
- ✅ / ❌ Whether your template ID is set
- ✅ / ❌ Whether the template is accessible
- ✅ / ❌ Whether the role name matches a role in your template
- ✅ What roles are actually in your template (helpful for debugging `SIGNNOW_ROLE_NAME`)

**Example of a healthy response:**
```json
{
  "overall": "✅ All checks passed — SignNow is correctly configured",
  "auth": { "method": "oauth", "status": "✅ Token obtained successfully" },
  "templateId": { "status": "✅ Set" },
  "template": {
    "status": "✅ Template accessible",
    "roles": ["Signer 1"],
    "roleMatch": "✅ \"Signer 1\" found in template roles"
  }
}
```

---

## Step 6 — Test the Payment Form

1. Visit **[https://www.slytrans.com/car.html?vehicle=camry](https://www.slytrans.com/car.html?vehicle=camry)**.
2. Fill in pickup date, return date, email, and upload an ID.
3. Check the **"I agree"** checkbox.
4. Click **💳 Pay Now**.
5. The Stripe card form should appear below the button. ✅
6. Use test card **4242 4242 4242 4242** (any future expiry, any CVC) to test without real money.

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| "Could not load the payment form" alert | Missing Stripe env vars | Add `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` in Vercel → Settings → Env Vars, then Redeploy |
| "Server configuration error: STRIPE_SECRET_KEY is missing" | Env var not yet active | Re-check spelling (case-sensitive), save, and **Redeploy** |
| Card form never appears, no error shown | Browser blocked request | Open browser DevTools → Console/Network tab — look for a red network error and share it |
| Card form appears but payment fails | Wrong key type | Use test keys for testing (`sk_test_…` / `pk_test_…`) |
| Vercel deployment shows "Error" | Build or function error | Click the failed deployment in Vercel → check the Functions log |
| **Not receiving booking notification emails** | SMTP not configured, wrong password, or `OWNER_EMAIL` not set to your work email | Visit `https://sly-rides.vercel.app/api/check-email` — it shows exactly which variable is missing or why the connection is failing. Then fix the issue in Vercel → Settings → Env Vars and **Redeploy**. |
| Renter confirmation email shows wrong contact address | `OWNER_EMAIL` not set to your work email | Add `OWNER_EMAIL` = your work email in Vercel → Settings → Env Vars, then Redeploy |
| "Sign Agreement" button shows error message | Expired or missing SignNow token | **Use OAuth credentials (Option A):** add `SIGNNOW_CLIENT_ID`, `SIGNNOW_CLIENT_SECRET`, `SIGNNOW_EMAIL`, `SIGNNOW_PASSWORD` in Vercel → Settings → Env Vars, then Redeploy. Static tokens expire after ~30–60 min. |
| "Sign Agreement" button shows error message | Missing `SIGNNOW_TEMPLATE_ID` | Add `SIGNNOW_TEMPLATE_ID` in Vercel → Settings → Env Vars, then Redeploy |
| Renters see a previously filled-in contract | `SIGNNOW_TEMPLATE_ID` points to a document, not a template | Go to SignNow → Templates, get the template ID, update the env var, Redeploy |
| "Failed to send signing invite" in Vercel logs | Role name mismatch | The role `"Signer 1"` doesn't match your template. Set `SIGNNOW_ROLE_NAME` to the exact role name defined in your SignNow template, then Redeploy |
| Not sure what's wrong with SignNow setup | Need to diagnose | Visit `https://sly-rides.vercel.app/api/check-signnow` in your browser — it returns a detailed status report of every component |
| Booked dates don't appear as blocked on the calendar | `GITHUB_TOKEN` not set or has wrong permissions | Create a fine-grained PAT with Contents: Read and write on the SLY-RIDES repo and add it as `GITHUB_TOKEN` in Vercel → Settings → Env Vars, then Redeploy |

---

## Summary

| What | Status |
|---|---|
| Vercel project URL | `https://sly-rides.vercel.app` ✅ (this is correct) |
| Frontend URL | `https://www.slytrans.com` (GitHub Pages) |
| `STRIPE_SECRET_KEY` | Must be set in Vercel → Settings → Env Vars |
| `STRIPE_PUBLISHABLE_KEY` | Must be set in Vercel → Settings → Env Vars |
| `SMTP_HOST` | Must be set for emails to work (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | `587` (or `465` for SSL) |
| `SMTP_USER` | Sending email address |
| `SMTP_PASS` | App password for that email |
| `OWNER_EMAIL` | **Your work email** — booking notifications go here. Must be set or notifications use the default address. |
| Diagnose email setup | Visit `https://sly-rides.vercel.app/api/check-email` |
| `SIGNNOW_CLIENT_ID` + `SIGNNOW_CLIENT_SECRET` + `SIGNNOW_EMAIL` + `SIGNNOW_PASSWORD` | **Recommended** — OAuth credentials for reliable, non-expiring SignNow auth |
| `SIGNNOW_API_TOKEN` | Alternative to OAuth credentials — works but expires after ~30–60 min |
| `SIGNNOW_TEMPLATE_ID` | Must be set to the **template** ID in Vercel → Settings → Env Vars |
| `SIGNNOW_ROLE_NAME` | Optional — set only if your template's role is not `"Signer 1"` |
| `GITHUB_TOKEN` | Must be set to auto-block calendar dates after each booking |
| Redeploy after adding keys | Required — without redeploy, new env vars are not active |

