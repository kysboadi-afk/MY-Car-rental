# SLY RIDES - Car Rental Website

Modern, professional car rental website for SLY RIDES.

## 🚗 Features

- **Image Slideshow**: Browse multiple car photos with overlay navigation
- **Statistics Widget**: Display key metrics (10+ years, 7,500+ customers, 100% satisfaction, 99% safety)
- **Smart Pricing**: Automatic weekly rate calculation for 7+ day rentals
- **Responsive Design**: Mobile-optimized for all devices
- **Booking System**: Integrated with Stripe for payments

## 🚀 Quick Deploy to GoDaddy

**Want to deploy this to your GoDaddy hosting?**

👉 **[Read the Complete Deployment Guide](DEPLOYMENT.md)** 👈

### Quick Steps:
1. Download all files from this repository
2. Log into GoDaddy cPanel File Manager
3. Upload files to `public_html/` folder
4. Upload `images/` folder with all images
5. Visit your domain - Done! 🎉

---

## 📁 Project Structure

```
SLY-RIDES/
├── index.html          # Homepage with car listings
├── car.html           # Vehicle booking page
├── success.html       # Payment success page
├── cancel.html        # Payment cancellation page
├── style.css          # Main stylesheet
├── car.js             # Booking page logic
├── script.js          # Homepage scripts
├── images/            # Car photos and logo
└── DEPLOYMENT.md      # Full deployment guide
```

## 🌐 Live Demo

- **GitHub Pages**: https://kysboadi-afk.github.io/SLY-RIDES/
- **Your Domain**: After following the [deployment guide](DEPLOYMENT.md)

## 💻 Local Development

```bash
# Clone the repository
git clone https://github.com/kysboadi-afk/SLY-RIDES.git

# Navigate to directory
cd SLY-RIDES

# Open with any local server
python3 -m http.server 8000

# Visit http://localhost:8000
```

## 🎨 Customization

### Change Car Information
Edit `car.js` to update:
- Car names and descriptions
- Pricing (daily/weekly rates)
- Images

### Change Stats
Edit `index.html` stats section:
- Years of experience
- Customer count
- Satisfaction rating
- Safety percentage

### Change Branding
- Update logo: Replace `images/logo.jpg`
- Update colors: Modify `style.css`
- Update text: Edit HTML files

## 📝 License

© 2026 SLY RIDES. All rights reserved.

# SLY-RIDES
Simple car rental website — live at **[https://www.slytrans.com](https://www.slytrans.com)** 🚗

## 📧 Need to update the Vercel backend (reservation emails)?

See the step-by-step guide: **[VERCEL_SETUP.md](VERCEL_SETUP.md)**

## ✅ All Updates Deployed

All pull requests have been merged to `main` and the site is fully live at **www.slytrans.com**.

---

## Domain Status

| Step | Status |
|------|--------|
| GoDaddy DNS records configured | ✅ Done |
| DNS propagated | ✅ Done |
| GitHub Pages custom domain set | ✅ Done |
| Enforce HTTPS enabled | ✅ Done |
| All pull requests merged to main | ✅ Done |

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
