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

## 📸 Adding Photos to a Vehicle (Booking Page)

The booking page shows a photo slideshow for each vehicle. Here's how to add new photos:

### Step 1 — Upload the image file

Put your photo in the **`images/`** folder in the root of the repository.  
Accepted formats: `.jpg`, `.jpeg`, `.png`, `.webp`  
Example: `images/slingshot-front.jpg`

### Step 2 — Reference the photo in `car.js`

Open `car.js` and find the vehicle you want to update.  
Add the new filename to that vehicle's `images` array:

**Slingshot 1** (look for the comment `// TO ADD PHOTOS FOR SLINGSHOT 1:`):
```js
images: ["images/car2.jpg", "images/car1.jpg", "images/car3.jpg", "images/slingshot-front.jpg"],
```

**Slingshot 2** (look for the comment `// TO ADD PHOTOS FOR SLINGSHOT 2:`):
```js
images: ["images/IMG_1749.jpeg", "images/IMG_1750.jpeg", "images/IMG_1751.jpeg", "images/slingshot2-front.jpg"],
```

Photos appear in the slider in the order they are listed.  
The first photo in the list is shown by default.

### Step 3 — Push to `main`

Commit and push your changes. The site deploys automatically.

---

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

## 🔐 Admin Dashboard

**Fleet Control (new):** [https://www.slytrans.com/admin-v2/](https://www.slytrans.com/admin-v2/)
**Legacy Admin:** [https://www.slytrans.com/admin.html](https://www.slytrans.com/admin.html)

You can also reach the admin from any page on the site — click the small **Admin** link in the footer.

## 📧 Need to update the Vercel backend (reservation emails)?

See the step-by-step guide: **[VERCEL_SETUP.md](VERCEL_SETUP.md)**

## ✅ All Updates Deployed

All pull requests have been merged to `main`. The site deploys automatically from `main` via GitHub Actions on every push.

> **⚠️ One-time setup required:** Go to **Settings → Pages → Source** and select **"GitHub Actions"** (instead of a branch). This ensures the site always deploys from `main` with the latest changes.

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
| CNAME | www | kysboadi-afk.github.io |
