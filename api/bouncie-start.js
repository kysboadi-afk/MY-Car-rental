// api/bouncie-start.js
// Stub — OAuth authentication has been replaced by API key authentication.
//
// Bouncie GPS sync now uses the BOUNCIE_API_KEY environment variable
// (set in the Vercel dashboard) with the api.bouncie.dev/v1 API.
// No OAuth flow is required.

export default function handler(req, res) {
  return res.status(200).json({
    message: "Bouncie uses API key authentication. Set the BOUNCIE_API_KEY environment variable in your Vercel dashboard.",
  });
}
