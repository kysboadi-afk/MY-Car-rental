# 🚀 How to Update Your Vercel Backend

Your Vercel backend is the project running at:
**`https://slyservices-stripe-backend-ipeq.vercel.app`**

It handles Stripe payments and sends reservation emails. Follow the steps below to deploy the latest files.

> ⚠️ **Important:** `api/create-checkout-session.js` has also been updated — it now includes CORS headers and fixed redirect URLs. You must redeploy **both** API files for Stripe payments to work correctly.

---

## Step 1 — Find Your Vercel Backend Project

Your Vercel backend is a **separate** project from this GitHub Pages site. You need to locate it:

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)** and log in.
2. Find the project named something like **slyservices-stripe-backend** (it's the one connected to `slyservices-stripe-backend-ipeq.vercel.app`).
3. Click on it to open the project dashboard.

---

## Step 2 — Update Both API Files

You need to copy **both** files from the `api/` folder in this repo into your Vercel backend project's `api/` folder:

| File | What changed |
|------|-------------|
| `api/create-checkout-session.js` | **Updated** — added CORS headers and fixed success/cancel redirect URLs (this is why Stripe wasn't working) |
| `api/send-reservation-email.js` | **New** — sends reservation notification + customer confirmation emails |

### Option A — If your Vercel project is linked to a GitHub repo (recommended)

1. Go to your Vercel backend's GitHub repository.
2. Navigate to the `api/` folder.
3. **Replace** `api/create-checkout-session.js` with the updated version from this repo (click the file → pencil icon → paste new contents → commit).
4. **Add** `api/send-reservation-email.js`: click **"Add file" → "Create new file"**, name it `api/send-reservation-email.js`, paste in the full contents from this repo, and commit.
5. Vercel will automatically redeploy within ~1 minute.

### Option B — If you have the project files on your computer

1. Open the Vercel backend project folder on your computer.
2. **Replace** `api/create-checkout-session.js` with the updated version from this repo.
3. **Copy** `api/send-reservation-email.js` from this repo into the backend's `api/` folder.
4. Open a terminal in that folder and run:
   ```bash
   npm install nodemailer
   ```
5. Commit and push:
   ```bash
   git add .
   git commit -m "Fix CORS and add reservation email endpoint"
   git push
   ```
   Vercel will redeploy automatically.

### Option C — If the backend has no GitHub repo (deployed directly)

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)** → your backend project.
2. Go to the **"Deployments"** tab and note the current Git source.
3. Use the [Vercel CLI](https://vercel.com/docs/cli):
   ```bash
   npm install -g vercel
   vercel login
   vercel --prod
   ```

---

## Step 3 — Install nodemailer

The email endpoint requires the `nodemailer` package. In your Vercel backend project folder, run:

```bash
npm install nodemailer
```

Then make sure `package.json` has it listed under `dependencies` before pushing/deploying.

---

## Step 4 — Add Environment Variables in Vercel

This is the most important step. Without these, emails won't send.

1. In your Vercel dashboard, open your backend project.
2. Go to **Settings → Environment Variables**.
3. Add each of the following variables (click **"Add New"** for each):

| Variable Name | What to put |
|---------------|-------------|
| `SMTP_HOST` | Your email provider's SMTP server — see table below |
| `SMTP_PORT` | `587` (recommended) |
| `SMTP_USER` | The email address that sends the emails (e.g. your Gmail) |
| `SMTP_PASS` | The password for that email — **use an App Password, not your regular password** |
| `OWNER_EMAIL` | `slyservices@supports-info.com` |

### SMTP server values by email provider:

| Email Provider | SMTP_HOST | SMTP_PORT |
|----------------|-----------|-----------|
| Gmail | `smtp.gmail.com` | `587` |
| Outlook / Hotmail | `smtp.office365.com` | `587` |
| Yahoo Mail | `smtp.mail.yahoo.com` | `587` |
| iCloud Mail | `smtp.mail.me.com` | `587` |

### 📌 How to get a Gmail App Password (required if using Gmail):

Gmail blocks regular passwords for apps. You need an **App Password**:

1. Go to your Google Account → **[https://myaccount.google.com/security](https://myaccount.google.com/security)**
2. Make sure **2-Step Verification** is turned ON.
3. Search for **"App passwords"** on that page and click it.
4. Choose **"Mail"** as the app and **"Other"** as the device → name it `SLY Rides`.
5. Google will give you a 16-character password — copy it.
6. Use that 16-character password as your `SMTP_PASS` value in Vercel.

---

## Step 5 — Redeploy

After adding the environment variables:

1. Go to the **"Deployments"** tab of your Vercel backend project.
2. Click the three dots (⋯) next to the latest deployment.
3. Click **"Redeploy"**.
4. Wait ~30 seconds for the deployment to complete (status turns green ✅).

---

## Step 6 — Test It

Once deployed, test by making a reservation on **[www.slytrans.com](https://www.slytrans.com)**:

1. Select a car, fill in dates and your email, upload an ID.
2. Click **"Reserve Without Paying"**.
3. Check `slyservices@supports-info.com` — you should receive a reservation notification.
4. Check the customer email address — they should receive a booking confirmation.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No email received | Check that all 5 SMTP env vars are set correctly in Vercel and redeploy |
| Gmail "authentication failed" | Make sure you're using an App Password (Step 4), not your regular Gmail password |
| "Email sending failed" error in browser console | Check Vercel function logs: Dashboard → Deployments → latest deploy → **Functions** tab |
| CORS error in browser | Make sure the deployed URL matches `https://slyservices-stripe-backend-ipeq.vercel.app` |

---

## Summary

```
Your Vercel Backend Project
├── api/
│   ├── create-checkout-session.js   ✅ already live (Stripe payments)
│   └── send-reservation-email.js    ← ADD THIS FILE (reservation emails)
├── package.json                     ← add "nodemailer" to dependencies
└── ...
```

Environment variables to add in Vercel:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `OWNER_EMAIL`
