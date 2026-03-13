// api/get-reviews.js
// Vercel serverless function — fetches Google Reviews via the Places Details API
//
// Required environment variables (set in Vercel dashboard):
//   GOOGLE_PLACES_API_KEY  — Google Cloud API key with Places API enabled
//   GOOGLE_PLACE_ID        — Place ID for the business (find at
//                            https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder)

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    console.error("Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID environment variables.");
    return res.status(500).json({ error: "Google Reviews not configured." });
  }

  const fields = "name,rating,user_ratings_total,reviews,url";
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(fields)}&reviews_sort=newest&key=${apiKey}`;

  const response = await fetch(url);
  if (!response.ok) {
    console.error("Google Places API error:", response.status, await response.text());
    return res.status(502).json({ error: "Failed to fetch reviews from Google." });
  }

  const data = await response.json();

  if (data.status !== "OK") {
    console.error("Google Places API returned status:", data.status, data.error_message);
    return res.status(502).json({ error: "Google Places API error: " + (data.error_message || data.status) });
  }

  const result = data.result || {};

  // Cache the response for 1 hour to avoid unnecessary API quota usage
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  return res.status(200).json({
    name:               result.name               || "",
    rating:             result.rating             || null,
    userRatingsTotal:   result.user_ratings_total || 0,
    googleMapsUrl:      result.url                || "",
    reviews: (result.reviews || []).map((r) => ({
      authorName:              r.author_name,
      authorUrl:               r.author_url,
      profilePhotoUrl:         r.profile_photo_url,
      rating:                  r.rating,
      text:                    r.text,
      relativeTimeDescription: r.relative_time_description,
    })),
  });
}
