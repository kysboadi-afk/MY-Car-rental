# Copilot Instructions for SLY RIDES

## Project Overview

SLY RIDES is a static car rental website for **SLY Transportation Services**, a Los Angeles-based car rental company. The frontend is deployed on **GitHub Pages** with a custom domain at [www.slytrans.com](https://www.slytrans.com). The backend consists of Vercel serverless functions.

## Tech Stack

- **Frontend**: Plain HTML, CSS, and vanilla JavaScript (no build framework)
- **Backend**: Node.js (ES modules) serverless functions hosted on Vercel
- **Payments**: Stripe Checkout (`api/create-checkout-session.js`)
- **Email**: Nodemailer via SMTP (`api/send-reservation-email.js`)
- **Hosting**: GitHub Pages (frontend) + Vercel (API)

## Repository Structure

```
SLY-RIDES/
├── index.html              # Homepage — car listings, stats, about section
├── car.html                # Vehicle booking page with date picker and payment
├── success.html            # Stripe payment success landing page
├── cancel.html             # Stripe payment cancellation landing page
├── style.css               # Main stylesheet (all pages share this)
├── script.js               # Homepage scripts (availability check)
├── car.js                  # Booking page logic (pricing, Stripe, email)
├── chatbot.js              # Floating chatbot widget
├── images/                 # Car photos and logo (logo.jpg, car2.jpg, car5.jpg, …)
├── api/
│   ├── create-checkout-session.js  # Vercel fn: Stripe checkout
│   └── send-reservation-email.js   # Vercel fn: SMTP confirmation emails
└── package.json            # Backend dependencies (stripe, nodemailer)
```

## Key Conventions

- **ES modules**: The `api/` functions use `import`/`export default` syntax (`"type": "module"` in `package.json`).
- **CORS**: Both API handlers whitelist `https://www.slytrans.com` and `https://slytrans.com` only. Maintain this allowlist when modifying or adding API endpoints.
- **HTML escaping**: The `esc()` helper in `send-reservation-email.js` must be applied to all user-supplied values before embedding them in email HTML to prevent XSS. Always use it when adding new fields to email templates.
- **Currency**: Stripe amounts are in **whole cents** (`Math.round(amount * 100)`). Keep this conversion consistent.
- **Pricing logic**: Weekly rate applies for rentals of 7+ days (see `car.js`). Any pricing changes must update both the display logic and the Stripe session amount.
- **No build step**: The frontend is served as-is from the repo root. Avoid adding bundlers or transpilers unless absolutely necessary.
- **No test framework**: There is currently no automated test infrastructure. Manual testing via a local HTTP server (`python3 -m http.server 8000`) is the standard approach.

## Environment Variables (Vercel)

These must be configured in the Vercel dashboard — never hardcode them:

| Variable        | Description                              |
|-----------------|------------------------------------------|
| `STRIPE_SECRET_KEY` | Stripe secret key                    |
| `SMTP_HOST`     | SMTP server hostname                     |
| `SMTP_PORT`     | SMTP port (587 for TLS, 465 for SSL)     |
| `SMTP_USER`     | Sending email address                    |
| `SMTP_PASS`     | Email password / app password            |
| `OWNER_EMAIL`   | Business email for reservation alerts    |

## Vehicles

Currently two vehicles are configured:

| Key         | Name         | Daily Rate | Deposit | Weekly Rate |
|-------------|--------------|------------|---------|-------------|
| `slingshot` | Slingshot R  | $300/day   | $150    | N/A         |
| `camry`     | Camry 2012   | $50/day    | N/A     | $300/week   |

Vehicle data lives in `car.js`. To add a new vehicle: update `car.js`, add a card in `index.html`, and add the car image to `images/`.

## Deployment

- **Frontend** deploys automatically on every push to `main` via GitHub Pages.
- **Backend** deploys automatically on every push to `main` via Vercel.
- No manual deployment steps are required after merging to `main`.
