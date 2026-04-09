export default function handler(req, res) {
  const clientId = process.env.BOUNCIE_CLIENT_ID;
  const redirectUri = process.env.BOUNCIE_REDIRECT_URI;

  const url = `https://auth.bouncie.com/dialog/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;

  return res.redirect(url);
}
