// api/connect-gps.js
// Redirects to the Bouncie OAuth connect flow.

export default function handler(req, res) {
  res.redirect("/api/bouncie-connect");
}
