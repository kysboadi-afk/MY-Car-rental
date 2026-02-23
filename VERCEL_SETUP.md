# 🚀 Setting Up Stripe + Vercel From Scratch

This guide walks you through connecting **this GitHub repository** directly to Vercel so that the Stripe payment form works on your booking page.  
After following these steps, the card form will appear automatically when a customer clicks **💳 Pay Now** — no separate backend project needed.

---

## How It Works (Overview)

```
Customer fills booking form → clicks Pay Now
  → browser calls /api/create-payment-intent  (your Vercel function)
    → Vercel calls Stripe with your secret key → gets a clientSecret
  → browser receives clientSecret + publishableKey
  → Stripe Payment Element mounts (card form appears) ✅
  → customer enters card → Stripe processes payment
```

Everything runs inside **one Vercel project** linked to this GitHub repo.

---

## Step 1 — Import This Repo into Vercel

1. Go to **[https://vercel.com/new](https://vercel.com/new)** and log in (or sign up — it's free).
2. Click **"Import Git Repository"**.
3. If this repo is in your GitHub account, select it from the list.  
   *(If it doesn't appear, click "Adjust GitHub App Permissions" and grant access.)*
4. Leave all the default settings as-is — Vercel will auto-detect the `api/` folder.
5. Click **"Deploy"** and wait ~30 seconds for the first deployment to finish.

> ✅ Your site is now live at something like `https://sly-rides.vercel.app`.  
> The card form still won't work yet — you need to add your Stripe keys in Step 2.

---

## Step 2 — Add Your Stripe API Keys in Vercel

This is the most important step. Without these keys, the payment form cannot load.

### Get your keys from Stripe

1. Go to **[https://dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)** and log in.
2. You will see two keys — copy both:
   - **Publishable key** — starts with `pk_live_` or `pk_test_`
   - **Secret key** — starts with `sk_live_` or `sk_test_`

> 💡 Use `pk_test_` / `sk_test_` keys while testing. Switch to live keys when ready to accept real payments.

### Add them to Vercel

1. In the Vercel dashboard, open your **sly-rides** project.
2. Go to **Settings → Environment Variables**.
3. Add the following two variables (click **"Add New"** for each):

| Variable Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your secret key (`sk_live_…` or `sk_test_…`) |
| `STRIPE_PUBLISHABLE_KEY` | Your publishable key (`pk_live_…` or `pk_test_…`) |

4. After adding both, click **Save**.
5. Go to **Deployments → Redeploy** the latest deployment so the new variables take effect.

---

## Step 3 — Add Your Email Variables (for Reservation Emails)

If you also want to receive reservation notification emails, add these:

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
3. Search for **"App passwords"** and click it.
4. Choose **Mail** → **Other (Custom name)** → name it `SLY Rides`.
5. Copy the 16-character password and use it as `SMTP_PASS`.

---

## Step 4 — Point www.slytrans.com to Vercel

Since Vercel is now running both the frontend and the API, point your domain to it.

1. In Vercel, go to your project → **Settings → Domains**.
2. Click **"Add Domain"** and enter `www.slytrans.com`.
3. Vercel will show you DNS records to add.
4. Log in to **GoDaddy** (or wherever your domain is registered) → DNS settings.
5. Update the records as instructed by Vercel (usually a CNAME pointing to `cname.vercel-dns.com`).
6. DNS changes can take up to 24 hours, but usually update within a few minutes.

> ⚠️ Once you point the domain to Vercel, GitHub Pages will no longer serve the site.  
> That's fine — Vercel will serve everything including the API.

---

## Step 5 — Test the Payment Form

1. Visit **[https://www.slytrans.com/car.html?vehicle=camry](https://www.slytrans.com/car.html?vehicle=camry)** (or your Vercel URL while DNS is propagating).
2. Fill in pickup date, return date, email, and upload an ID.
3. Check the "I agree" checkbox.
4. Click **💳 Pay Now**.
5. The Stripe card form should appear immediately below the button. ✅
6. Use the test card **4242 4242 4242 4242** (any future expiry, any CVC) to simulate a successful payment.

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| "Could not load payment form" alert | Missing Stripe env vars | Add `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` in Vercel → Settings → Environment Variables, then Redeploy |
| "Server configuration error: STRIPE_SECRET_KEY is missing" | Env var not saved | Re-check the variable names (case-sensitive), save, and redeploy |
| Card form appears but payment fails | Wrong Stripe key type (live vs test) | Make sure you're using test keys for testing, live keys for real payments |
| CORS error in browser console | Old separate backend project still being called | Make sure `API_BASE` in `car.js` is set to `""` (empty string) and redeploy |
| Domain still shows GitHub Pages | DNS hasn't updated yet | Wait up to 24 hours, or check the Vercel domain settings for the correct DNS values |

---

## Summary — What You Need

| What | Where |
|---|---|
| Vercel account (free) | vercel.com |
| Stripe account (free) | dashboard.stripe.com |
| `STRIPE_SECRET_KEY` env var | Vercel → Settings → Environment Variables |
| `STRIPE_PUBLISHABLE_KEY` env var | Vercel → Settings → Environment Variables |
| Domain DNS updated | GoDaddy → DNS → point to Vercel |

