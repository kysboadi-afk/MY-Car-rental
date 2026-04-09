// api/bouncieCallback.js
// Legacy camelCase alias — kept so any cached redirect URIs continue to work.
// The implementation lives in _handle-bouncie-callback.js.
//
// NOTE: Vercel cannot bundle ESM re-exports (export { default } from "...")
// into serverless functions — each route file must define its own handler.

import handleBouncieCallback from "./_handle-bouncie-callback.js";

export default async function handler(req, res) {
  return handleBouncieCallback(req, res);
}
