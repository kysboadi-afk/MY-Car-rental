// api/bouncie-oauth.js
// Stub route — re-exports the informational handler from _bouncie.js.
//
// Vercel does NOT expose files whose names start with "_" as HTTP routes
// (they are treated as private utility modules).  This thin wrapper re-exports
// the handler from _bouncie.js so the route /api/bouncie-oauth continues to
// serve a meaningful response for any cached or bookmarked URLs.

export { default } from "./_bouncie.js";
