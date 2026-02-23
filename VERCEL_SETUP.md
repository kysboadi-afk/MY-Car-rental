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

Optional but recommended. Without these, no emails are sent.

| Variable Name | Value |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your sending email address |
| `SMTP_PASS` | App password for that email (see below) |
| `OWNER_EMAIL` | `slyservices@supports-info.com` |

### How to get a Gmail App Password

1. Go to **[https://myaccount.google.com/security](https://myaccount.google.com/security)**.
2. Make sure **2-Step Verification** is ON.
3. Search for **"App passwords"** → click it.
4. Choose **Mail** → **Other (Custom name)** → name it `SLY Rides`.
5. Copy the 16-character password → use it as `SMTP_PASS` in Vercel.

---

## Step 4 — Test the Payment Form

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

---

## Summary

| What | Status |
|---|---|
| Vercel project URL | `https://sly-rides.vercel.app` ✅ (this is correct) |
| Frontend URL | `https://www.slytrans.com` (GitHub Pages) |
| `STRIPE_SECRET_KEY` | Must be set in Vercel → Settings → Env Vars |
| `STRIPE_PUBLISHABLE_KEY` | Must be set in Vercel → Settings → Env Vars |
| Redeploy after adding keys | Required — without redeploy, new env vars are not active |

