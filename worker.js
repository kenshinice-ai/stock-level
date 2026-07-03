const OW = {
  stores: "https://www.officeworks.com.au/contact-us?view=stores&format=json",
  productSearch: "https://www.officeworks.com.au/shop/ProductSearchView?pageSize=50&langId=-1&catalogId=-1&storeId=10151&searchTerm=",
  availabilityBase: "https://api.officeworks.com.au/v2/availability/store"
};

const ALLOWED_STATES = new Set([
  "all", "ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        return html(`
          <!doctype html>
          <html>
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <title>Officeworks Stock Worker</title>
              <style>
                body { font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 40px; line-height: 1.5; }
                code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
              </style>
            </head>
            <body>
              <h1>Officeworks Stock Worker is running.</h1>
              <p>Try <code>/api/health</code> or <code>/api/check?sku=APMJQJ3ZA&state=VIC</code>.</p>
            </body>
          </html>
        `);
      }

      if (path === "/api/health") {
        return json({
          ok: true,
          service: "officeworks-stock-worker",
          time: new Date().toISOString()
        });
      }

      if (path === "/api/stores") {
        const state = normaliseState(url.searchParams.get("state") || "all");
        const stores = await getStores(state);
        return json({
          ok: true,
          state,
          count: stores.length,
          stores
        });
      }

      if (path === "/api/product") {
        const sku = normaliseSku(url.searchParams.get("sku"));
        if (!sku) return json({ error: "Missing or invalid sku" }, 400);

        const product = await getProduct(sku);
        return json({
          ok: true,
          product
        });
      }

      if (path === "/api/check") {
        const sku = normaliseSku(url.searchParams.get("sku"));
        const state = normaliseState(url.searchParams.get("state") || "all");

        if (!sku) return json({ error: "Missing or invalid sku" }, 400);

        const startedAt = Date.now();

        const [product, stores] = await Promise.all([
          getProduct(sku),
          getStores(state)
        ]);

        if (!stores.length) {
          return json({
            ok: true,
            product,
            state,
            summary: {
              storesChecked: 0,
              storesWithStock: 0,
              totalVisibleStock: 0,
              durationMs: Date.now() - startedAt
            },
            rows: []
          });
        }

        const rows = await mapLimit(stores, 8, async (store) => {
          const qty = await getStockQty(store.storeId, sku).catch(() => null);

          return {
            storeId: store.storeId,
            storeName: store.storeName,
            address: store.address,
            suburb: store.suburb,
            state: store.state,
            postcode: store.postcode,
            phone: store.phone,
            qty
          };
        });

        rows.sort((a, b) => Number(b.qty || 0) - Number(a.qty || 0));

        const storesWithStock = rows.filter(r => Number(r.qty || 0) > 0).length;
        const totalVisibleStock = rows.reduce((sum, r) => {
          const qty = Number(r.qty || 0);
          return sum + (Number.isFinite(qty) ? qty : 0);
        }, 0);

        return json({
          ok: true,
          product,
          state,
          summary: {
            storesChecked: rows.length,
            storesWithStock,
            totalVisibleStock,
            durationMs: Date.now() - startedAt
          },
          rows
        });
      }

      return json({ error: "Not found" }, 404);

    } catch (err) {
      return json({
        error: err?.message || "Unexpected worker error"
      }, 500);
    }
  }
};

function normaliseSku(value) {
  const sku = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!/^[A-Z0-9]{4,30}$/.test(sku)) return "";
  return sku;
}

function normaliseState(value) {
  const state = String(value || "all").trim().toUpperCase();
  if (state === "ALL") return "all";
  if (!ALLOWED_STATES.has(state)) return "all";
  return state;
}

async function getStores(state = "all") {
  const cache = caches.default;
  const cacheKey = new Request(`https://worker-cache.local/stores?state=${state}`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const raw = await fetchJson(OW.stores, {
    cacheTtl: 43200
  });

  const sourceStores = Array.isArray(raw?.stores)
    ? raw.stores
    : Array.isArray(raw)
      ? raw
      : [];

  const stores = sourceStores
    .map(normaliseStore)
    .filter(s => s.storeId && s.storeName);

  const filtered = state === "all"
    ? stores
    : stores.filter(s => String(s.state || "").toUpperCase() === state);

  const response = new Response(JSON.stringify(filtered), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=43200"
    }
  });

  await cache.put(cacheKey, response.clone());
  return filtered;
}

function normaliseStore(store) {
  const addressObj = store?.address || {};
  const contactObj = store?.contact || {};

  return {
    storeId: String(
      store?.storeId ||
      store?.id ||
      store?.storeNumber ||
      ""
    ),
    storeName: String(
      store?.storeName ||
      store?.name ||
      ""
    ),
    address: String(
      addressObj?.storeAddressLine ||
      addressObj?.addressLine1 ||
      addressObj?.address ||
      ""
    ),
    suburb: String(
      addressObj?.storeCity ||
      addressObj?.suburb ||
      addressObj?.city ||
      ""
    ),
    state: String(
      addressObj?.storeState ||
      addressObj?.state ||
      ""
    ).toUpperCase(),
    postcode: String(
      addressObj?.storePostcode ||
      addressObj?.postcode ||
      ""
    ),
    phone: String(
      contactObj?.storeTelephone ||
      contactObj?.phone ||
      store?.phone ||
      ""
    )
  };
}

async function getProduct(sku) {
  const cache = caches.default;
  const cacheKey = new Request(`https://worker-cache.local/product?sku=${sku}`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const url = OW.productSearch + encodeURIComponent(sku);
  const data = await fetchJson(url, {
    cacheTtl: 3600
  }).catch(() => null);

  const products = Array.isArray(data?.products) ? data.products : [];

  const exact = products.find(p => {
    const part = String(
      p?.identity?.partNumber ||
      p?.partNumber ||
      p?.sku ||
      ""
    ).toUpperCase();

    return part === sku;
  });

  const first = exact || products[0] || null;

  const product = {
    sku,
    name: String(
      first?.identity?.name ||
      first?.name ||
      sku
    ),
    partNumber: String(
      first?.identity?.partNumber ||
      first?.partNumber ||
      sku
    ),
    rawFound: Boolean(first)
  };

  const response = new Response(JSON.stringify(product), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600"
    }
  });

  await cache.put(cacheKey, response.clone());
  return product;
}

async function getStockQty(storeId, sku) {
  const url = `${OW.availabilityBase}/${encodeURIComponent(storeId)}?partNumber=${encodeURIComponent(sku)}`;

  const data = await fetchJson(url, {
    cacheTtl: 0
  });

  return extractQty(data);
}

function extractQty(data) {
  const candidates = [];

  if (Array.isArray(data)) candidates.push(...data);
  else if (data && typeof data === "object") candidates.push(data);

  for (const item of candidates) {
    if (typeof item?.qty === "number") return item.qty;
    if (typeof item?.quantity === "number") return item.quantity;
    if (typeof item?.stock === "number") return item.stock;

    const options = Array.isArray(item?.options) ? item.options : [];

    for (const opt of options) {
      const type = String(opt?.type || "").toLowerCase();

      if (
        type === "instore" ||
        type === "in_store" ||
        type === "in-store" ||
        type.includes("store")
      ) {
        const qty = Number(
          opt?.qty ??
          opt?.quantity ??
          opt?.stock ??
          0
        );

        return Number.isFinite(qty) ? qty : 0;
      }
    }
  }

  return 0;
}

async function fetchJson(url, options = {}) {
  const cacheTtl = Number(options.cacheTtl || 0);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/2.0"
    },
    cf: cacheTtl > 0
      ? { cacheTtl, cacheEverything: true }
      : { cacheTtl: 0 }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  return res.json();
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      ...CORS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
