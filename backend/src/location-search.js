const { isBangladeshPoint } = require("./bangladesh-boundary");
const locationSearchCache = new Map();
let lastLocationSearchAt = 0;

async function searchBangladeshLocations(query) {
  const originalQuery = query.trim();
  const cacheKey = originalQuery.normalize("NFKC").toLocaleLowerCase();
  const cached = locationSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { results: cached.results };
  const waitMs = 1000 - (Date.now() - lastLocationSearchAt);
  if (waitMs > 0) return { retryAfter: Math.ceil(waitMs / 1000) };

  const queries = [originalQuery];
  if (!/\bbangladesh\b/i.test(originalQuery) && !originalQuery.toLocaleLowerCase().includes("bd")) {
    queries.push(`${originalQuery}, Bangladesh`);
  }

  let results = [];
  for (const searchQuery of queries) {
    if (results.length) break;
    if (Date.now() - lastLocationSearchAt < 1000) {
      await new Promise(resolve => setTimeout(resolve, 1000 - (Date.now() - lastLocationSearchAt)));
    }

    const endpoint = new URL(process.env.LOCATION_SEARCH_URL || "https://nominatim.openstreetmap.org/search");
    endpoint.searchParams.set("q", searchQuery);
    endpoint.searchParams.set("countrycodes", "bd");
    endpoint.searchParams.set("format", "jsonv2");
    endpoint.searchParams.set("addressdetails", "1");
    endpoint.searchParams.set("namedetails", "1");
    endpoint.searchParams.set("limit", "8");
    lastLocationSearchAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          "User-Agent": "LostTrack/1.0 (campus lost-and-found application)"
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Location search provider returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("Location search provider returned an invalid response.");
      results = payload.filter(item => {
        const hasCoordinates = item && item.lat !== null && item.lat !== undefined &&
          item.lon !== null && item.lon !== undefined &&
          String(item.lat).trim() !== "" && String(item.lon).trim() !== "";
        const latitude = Number(item?.lat);
        const longitude = Number(item?.lon);
        return hasCoordinates && typeof item.display_name === "string" &&
          isBangladeshPoint(latitude, longitude);
      }).map(item => {
        const nameEnglish = typeof item.namedetails?.["name:en"] === "string"
          ? item.namedetails["name:en"].trim()
          : "";
        const displayName = item.display_name.trim();
        return {
          name: nameEnglish || displayName.split(",")[0].trim(),
          nameEnglish,
          displayName,
          latitude: Number(item.lat),
          longitude: Number(item.lon),
          type: typeof item.type === "string" ? item.type : ""
        };
      });
      results = [...new Map(results.map(item => [
        `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`,
        item
      ])).values()];
    } finally {
      clearTimeout(timeout);
    }
  }

  locationSearchCache.set(cacheKey, { results, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  if (locationSearchCache.size > 200) {
    const oldestKey = locationSearchCache.keys().next().value;
    if (oldestKey) locationSearchCache.delete(oldestKey);
  }
  return { results };
}

module.exports = { searchBangladeshLocations };
