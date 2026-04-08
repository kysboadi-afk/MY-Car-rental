export default function handler(req, res) {
  const clientId = process.env.BOUNCIE_CLIENT_ID;

  const redirectUri = "https://sly-rides.vercel.app/api/gps-callback";

  const url = `https://auth.bouncie.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}`;

  res.redirect(url);
}
