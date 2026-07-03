const ALLOWED_HOSTS = new Set([
  "www.officeworks.com.au",
  "api.officeworks.com.au"
]);

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get("url");

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!target) {
      return json({ error: "Missing url parameter" }, 400, corsHeaders);
    }

    let targetUrl;

    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: "Invalid target URL" }, 400, corsHeaders);
    }

    if (targetUrl.protocol !== "https:") {
      return json({ error: "Only HTTPS is allowed" }, 400, corsHeaders);
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return json({ error: "Host not allowed" }, 403, corsHeaders);
    }

    const allowedPaths = [
      "/contact-us",
      "/shop/ProductSearchView",
      "/v2/availability/store"
    ];

    const isAllowedPath = allowedPaths.some(path =>
      targetUrl.pathname.startsWith(path)
    );

    if (!isAllowedPath) {
      return json({ error: "Path not allowed" }, 403, corsHeaders);
    }

    const upstream = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 StockLevelChecker/1.0"
      }
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType
      }
    });
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    }
  });
}
