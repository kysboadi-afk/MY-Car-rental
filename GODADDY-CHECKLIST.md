# ✅ GoDaddy Deployment Checklist

Use this checklist to deploy SLY Rides to your GoDaddy hosting.

---

## Before You Start

- [ ] Have GoDaddy hosting account credentials
- [ ] Know your domain name
- [ ] Download ALL files from this GitHub repository
- [ ] Backup existing WordPress site (if replacing)

---

## Deployment Steps

### Access GoDaddy
- [ ] Log into GoDaddy.com
- [ ] Navigate to "My Products"
- [ ] Click "Manage" next to your Web Hosting
- [ ] Click "cPanel Admin" button

### Prepare Directory
- [ ] In cPanel, open "File Manager"
- [ ] Navigate to `public_html/` folder
- [ ] Choose deployment method:
  - [ ] **Replace WordPress**: Delete all files in public_html/
  - [ ] **Subdomain**: Create subdomain first, then go to its folder
  - [ ] **Subfolder**: Create new folder in public_html/

### Upload Files
- [ ] Click "Upload" button in File Manager
- [ ] Upload these HTML files:
  - [ ] index.html
  - [ ] car.html
  - [ ] success.html
  - [ ] cancel.html
- [ ] Upload these code files:
  - [ ] style.css
  - [ ] car.js
  - [ ] script.js
- [ ] Create `images/` folder in File Manager
- [ ] Upload all images to images/ folder:
  - [ ] logo.jpg
  - [ ] car1.jpg
  - [ ] car2.jpg
  - [ ] car3.jpg
  - [ ] car4.jpg
  - [ ] car5.jpg
  - [ ] car6.jpg

### Verify Upload
- [ ] Check that all files are in the correct directory
- [ ] Verify images/ folder contains all 7 images
- [ ] Check file permissions (should be 644 for files, 755 for folders)

---

## Test Your Website

Visit your website and check:

### Homepage (index.html)
- [ ] Page loads without errors
- [ ] SLY Rides logo appears at top
- [ ] Hero section displays
- [ ] Stats widget shows (10+, 7,500, 100%, 99%)
- [ ] Slingshot card shows front view
- [ ] Camry card shows back view
- [ ] Footer shows "© 2026 SLY Rides"

### Booking Pages
- [ ] Click "Select" on Slingshot - opens car.html?vehicle=slingshot
- [ ] First image shows (Slingshot front view)
- [ ] Click ❯ arrow - changes to next image
- [ ] Click ❮ arrow - goes back
- [ ] Dots below image work
- [ ] Booking form displays
- [ ] Same tests for Camry

### Mobile Testing
- [ ] Open site on mobile phone
- [ ] Stats show in 2x2 grid
- [ ] Images display correctly
- [ ] Navigation arrows work
- [ ] Booking form is readable

---

## Optional: Setup SSL (HTTPS)

- [ ] In cPanel, go to "SSL/TLS Status"
- [ ] Click "Run AutoSSL" for your domain
- [ ] Wait 5-10 minutes
- [ ] Visit https://yourdomain.com (note the 's')

---

## Troubleshooting

If something doesn't work:

### Images Don't Load
- [ ] Check images/ folder is in same location as index.html
- [ ] Verify all image files uploaded successfully
- [ ] Check file names match exactly (case-sensitive)

### Page Not Found (404)
- [ ] Verify files are in public_html/ (or correct subfolder)
- [ ] Check index.html exists and has correct name
- [ ] Try accessing: yourdomain.com/index.html directly

### Styling Looks Wrong
- [ ] Verify style.css uploaded
- [ ] Check file is in same folder as HTML files
- [ ] Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)

---

## 🎉 Success!

Once all checkboxes are complete, your SLY Rides website is live!

**Share your website:**
- Main domain: https://yourdomain.com
- Or subdomain: https://rides.yourdomain.com
- Or subfolder: https://yourdomain.com/rides/

---

## Need More Help?

- 📖 Read full guide: [DEPLOYMENT.md](DEPLOYMENT.md)
- 💬 Contact GoDaddy Support
- 📧 Check your GoDaddy account dashboard

**Congratulations on deploying SLY Rides! 🚗✨**
