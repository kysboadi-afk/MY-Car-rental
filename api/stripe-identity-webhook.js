export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Cache-Control", "no-store");
  return res.status(410).json({
    error: "Deprecated endpoint.",
    message: "Use /api/veriff-webhook for identity verification events.",
  });
}
