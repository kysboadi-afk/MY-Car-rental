// api/gps-callback.js
// GPS / Bouncie OAuth callback alias — forwards to the shared implementation.
//
// NOTE: Vercel cannot bundle ESM re-exports (export { default } from "...")
// into serverless functions — each route file must define its own handler.

import handleBouncieCallback from "./_handle-bouncie-callback.js";

export default async function handler(req, res) {
  return handleBouncieCallback(req, res);
}
