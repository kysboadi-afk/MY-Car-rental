// api/bouncie-oauth.js
// Public Vercel serverless route for the Bouncie OAuth callback.
//
// Vercel does NOT expose files whose names start with "_" as HTTP routes
// (they are treated as private utility modules).  This thin wrapper re-exports
// the handler from _bouncie.js so the route /api/bouncie-oauth is reachable.
//
// A rewrite in vercel.json maps /api/_bouncie → /api/bouncie-oauth, so the
// redirect URI registered with Bouncie (https://www.slytrans.com/api/_bouncie)
// continues to work without any changes in the Bouncie developer dashboard.

export { default } from "./_bouncie.js";
