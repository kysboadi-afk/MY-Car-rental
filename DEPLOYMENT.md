# 🚀 Deploying SLY Rides to GoDaddy Hosting

This guide will help you deploy your SLY Rides car rental website to your GoDaddy hosting account.

## 📋 Prerequisites

- GoDaddy hosting account (cPanel or Web Hosting)
- Domain name (either through GoDaddy or pointed to GoDaddy)
- FTP credentials or cPanel access

---

## 🎯 Option 1: Replace WordPress with SLY Rides (Main Domain)

If you want to replace your WordPress site completely with SLY Rides:

### Step 1: Backup Your WordPress Site
1. Log into your **GoDaddy cPanel**
2. Go to **Backup Wizard** and create a full backup
3. Download the backup to your computer (just in case!)

### Step 2: Clear the public_html Directory
1. In cPanel, open **File Manager**
2. Navigate to `public_html/` folder
3. **Select all WordPress files** (wp-admin, wp-content, wp-includes, etc.)
4. Click **Delete** (make sure you have a backup!)
5. Leave only `.htaccess` if it exists

### Step 3: Upload SLY Rides Files
1. Download ALL files from this GitHub repository
2. In **File Manager**, navigate to `public_html/`
3. Click **Upload** button
4. Upload these files:
   ```
   index.html
   car.html
   success.html
   cancel.html
   style.css
   car.js
   script.js
   ```
5. Create a folder called `images/` in public_html
6. Upload all images from the `images/` folder

### Step 4: Verify Deployment
1. Visit your domain: `https://yourdomain.com`
2. You should see the SLY Rides homepage!

---

## 🎯 Option 2: Deploy to Subdomain (Keep WordPress)

Deploy SLY Rides to a subdomain like `rides.yourdomain.com` while keeping WordPress on the main domain:

### Step 1: Create Subdomain
1. Log into **GoDaddy cPanel**
2. Go to **Domains** → **Subdomains**
3. Create subdomain: `rides` (or any name you prefer)
4. GoDaddy will create a folder like `public_html/rides/`

### Step 2: Upload SLY Rides Files
1. In **File Manager**, navigate to the new subdomain folder
2. Upload all SLY Rides files (same as Option 1, Step 3)

### Step 3: Verify Deployment
1. Visit: `https://rides.yourdomain.com`
2. You should see SLY Rides!

---

## 🎯 Option 3: Deploy to Subfolder (Keep WordPress)

Deploy SLY Rides to a subfolder like `yourdomain.com/rides/`:

### Step 1: Create Folder
1. In **File Manager**, navigate to `public_html/`
2. Click **+ Folder**
3. Name it: `rides` (or any name)

### Step 2: Upload Files
1. Navigate into the new `rides/` folder
2. Upload all SLY Rides files

### Step 3: Verify Deployment
1. Visit: `https://yourdomain.com/rides/`
2. You should see SLY Rides!

---

## 🔧 Using FTP Instead of File Manager

If you prefer FTP:

### Step 1: Get FTP Credentials
1. In GoDaddy **Hosting Dashboard**
2. Find **FTP** section
3. Note your:
   - **FTP Host**: Usually `ftp.yourdomain.com`
   - **Username**: Your FTP username
   - **Password**: Your FTP password

### Step 2: Connect with FTP Client
1. Download **FileZilla** (free FTP client)
2. Connect using your credentials:
   - Host: `ftp.yourdomain.com`
   - Port: 21
   - Username: (from Step 1)
   - Password: (from Step 1)

### Step 3: Upload Files
1. Navigate to `public_html/` (or subdomain folder)
2. Drag and drop all SLY Rides files
3. Upload the `images/` folder with all contents

---

## 📝 File Structure on Server

Your server should look like this:

```
public_html/                    (or subdomain folder)
├── index.html                 ← Homepage
├── car.html                   ← Booking page
├── success.html               ← Payment success page
├── cancel.html                ← Payment cancel page
├── style.css                  ← Styles
├── car.js                     ← Booking logic
├── script.js                  ← Scripts
└── images/                    ← Images folder
    ├── logo.jpg
    ├── car1.jpg
    ├── car2.jpg
    ├── car3.jpg
    ├── car4.jpg
    ├── car5.jpg
    └── car6.jpg
```

---

## 🌐 Domain Configuration

### If Using a Different Domain
1. Point your domain's nameservers to GoDaddy
2. Or update A records to point to GoDaddy's IP
3. Allow 24-48 hours for DNS propagation

### SSL Certificate (HTTPS)
1. In GoDaddy cPanel, go to **SSL/TLS Status**
2. Click **Run AutoSSL** for your domain
3. Or install free Let's Encrypt SSL
4. This ensures `https://` works

---

## ✅ Post-Deployment Checklist

After uploading, verify:
- [ ] Homepage loads: `https://yourdomain.com`
- [ ] Logo appears at the top
- [ ] Stats widget shows (10+, 7,500, 100%, 99%)
- [ ] Both car cards display (Slingshot & Camry)
- [ ] Clicking "Select" opens booking page
- [ ] Car images show in slideshow (one at a time)
- [ ] Navigation arrows work (❮ ❯)
- [ ] Booking form appears
- [ ] All images load correctly

---

## 🐛 Troubleshooting

### Images Not Loading
- Check that `images/` folder is in the same directory as `index.html`
- Verify all image files are uploaded
- Check file permissions (should be 644)

### Booking Form Not Working
- This requires the Stripe backend to be configured
- Payment processing needs server setup (separate from this static site)

### SSL/HTTPS Issues
- Install SSL certificate in cPanel
- Update any hardcoded `http://` links to `https://`

### 404 Error
- Check file names match exactly (case-sensitive)
- Verify you're in the correct directory (`public_html/`)

---

## 📞 Need Help?

### GoDaddy Support
- **Phone**: Available in your GoDaddy account dashboard
- **Live Chat**: Click "Help" in your GoDaddy dashboard
- **Support Page**: support.godaddy.com

### Common GoDaddy URLs
- **cPanel**: `https://yourdomain.com/cpanel`
- **Hosting Dashboard**: https://www.godaddy.com/hosting/web-hosting
- **File Manager**: cPanel → File Manager
- **FTP Details**: Hosting Dashboard → FTP

---

## 🎉 You're Done!

Your SLY Rides car rental website should now be live on your GoDaddy hosting!

Visit your domain to see it in action! 🚗✨
