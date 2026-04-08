export default function handler(req, res) {
  try {
    const clientId = process.env.BOUNCIE_CLIENT_ID;

    if (!clientId) {
      return res.status(500).send("Missing BOUNCIE_CLIENT_ID");
    }

    const redirectUri = "https://sly-rides.vercel.app/api/bouncie-callback";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
    });

    const url = `https://auth.bouncie.com/oauth/authorize?${params.toString()}`;

    return res.redirect(302, url);
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Unexpected error"
    });
  }
}
