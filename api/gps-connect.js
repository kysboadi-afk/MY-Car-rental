export default function handler(req, res) {
  try {
    const clientId = process.env.BOUNCIE_CLIENT_ID;

    if (!clientId) {
      return res.status(500).send("Missing BOUNCIE_CLIENT_ID");
    }

    const redirectUri = "https://sly-rides.vercel.app/api/gps-callback";

    const url =
      "https://auth.bouncie.com/oauth/authorize" +
      "?response_type=code" +
      "&client_id=" + encodeURIComponent(clientId) +
      "&redirect_uri=" + encodeURIComponent(redirectUri);

    return res.redirect(url);
  } catch (err) {
    console.error("gps-connect error:", err);
    return res.status(500).send("Internal error");
  }
}
