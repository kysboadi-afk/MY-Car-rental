# SLY-RIDES
Simple car rental website

## Custom Domain (GoDaddy)

This site is hosted on GitHub Pages at **www.slyrides.com**.

### GoDaddy DNS Configuration

To connect your GoDaddy domain to this GitHub Pages site, add the following records in your GoDaddy DNS settings:

**A Records** (point your apex/root domain to GitHub Pages):

| Type | Name | Value |
|------|------|-------|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

**CNAME Record** (for the `www` subdomain):

| Type | Name | Value |
|------|------|-------|
| CNAME | www | kysboadi-afk.github.io |

After saving the DNS records, go to your GitHub repository **Settings → Pages** and set the custom domain to `www.slyrides.com`. DNS propagation may take up to 48 hours.
