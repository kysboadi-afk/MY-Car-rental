// api/bouncie-connect.js
// Stub — Bouncie GPS sync uses API key authentication (BOUNCIE_API_KEY env var).
// No connection flow is required.

export default function handler(req, res) {
  return res.status(200).json({
    message: "Bouncie uses API key authentication. Set the BOUNCIE_API_KEY environment variable in your Vercel dashboard.",
  });
}
