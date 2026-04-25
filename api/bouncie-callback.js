// api/bouncie-callback.js
// Canonical handler for the Bouncie OAuth 2.0 callback.
//
// GET /api/bouncie-callback?code=<authorization_code>

import handleBouncieCallback from "./_handle-bouncie-callback.js";

export default async function handler(req, res) {
  return handleBouncieCallback(req, res);
}
