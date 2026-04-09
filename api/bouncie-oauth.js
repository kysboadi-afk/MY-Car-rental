// api/bouncie-oauth.js
// Informational stub — returns an HTML page explaining how to connect Bouncie.
//
// NOTE: Vercel cannot bundle ESM re-exports (export { default } from "...")
// into serverless functions — each route file must define its own handler.

export default function handler(req, res) {
  return res.status(200).send(
    "<!DOCTYPE html><html><head><title>Bouncie</title></head>" +
    "<body style='font-family:sans-serif;padding:2rem'>" +
    "<h2>ℹ️ Bouncie — OAuth Authentication</h2>" +
    "<p>To connect Bouncie GPS sync, visit <a href='/api/connectBouncie'>/api/connectBouncie</a>.</p>" +
    "</body></html>"
  );
}
