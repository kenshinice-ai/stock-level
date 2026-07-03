const OW = {
  stores: "https://www.officeworks.com.au/contact-us?view=stores&format=json",
  productSearch:
    "https://www.officeworks.com.au/shop/ProductSearchView?pageSize=50&langId=-1&catalogId=-1&storeId=10151&searchTerm=",
  availabilityBase: "https://api.officeworks.com.au/v2/availability/store"
};

const ALLOWED_STATES = new Set([
  "all",
  "ACT",
  "NSW",
  "NT",
  "QLD",
  "SA",
  "TAS",
  "VIC",
  "WA"
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
        return new Response(null, {
          status: 204,
          headers: CORS
        });
      }

      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);
      const path = normalisePath(url.pathname);

      if (path === "/api/health") {
        return json({
          ok: true,
          service: "officeworks-stock-worker",
          worker: "stock-level",
          time: new Date().toISOString()
        });
      }

      if (path === "/api/debug") {
        return json({
          ok: true,
          url: request.url,
          path,
          hasAssetsBinding: Boolean(env && env.ASSETS),
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

        if (!sku) {
          return json({ error: "Missing or invalid sku" }, 400);
        }

        const product = await getProduct(sku);

        return json({
          ok: true,
          product
        });
      }

      if (path === "/api/check") {
        const sku = normaliseSku(url.searchParams.get("sku"));
        const state = normaliseState(url.searchParams.get("state") || "all");

        if (!sku) {
          return json({ error: "Missing or invalid sku" }, 400);
        }

        const startedAt = Date.now();

        const [product, stores] = await Promise.all([
          getProduct(sku),
          getStores(state)
        ]);

        const rows = await mapLimit(stores, 6, async (store) => {
          let qty = null;
          let status = "unknown";
          let error = "";

          try {
            qty = await getStockQty(store.storeId, sku);
            status = qty > 0 ? "in_stock" : "no_stock";
          } catch (err) {
            qty = null;
            status = "error";
            error = err && err.message ? err.message : "Availability lookup failed";
          }

          return {
            storeId: store.storeId,
            storeName: store.storeName,
            address: store.address,
            suburb: store.suburb,
            state: store.state,
            postcode: store.postcode,
            phone: store.phone,
            qty,
            status,
            error
          };
        });

        rows.sort((a, b) => {
          const aq = Number(a.qty || 0);
          const bq = Number(b.qty || 0);
          return bq - aq || String(a.storeName).localeCompare(String(b.storeName));
        });

        const storesWithStock = rows.filter((r) => Number(r.qty || 0) > 0).length;
        const totalVisibleStock = rows.reduce((sum, r) => {
          const qty = Number(r.qty || 0);
          return Number.isFinite(qty) ? sum + qty : sum;
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

      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return html(fallbackHtml(), 200);
    } catch (err) {
      return json(
        {
          ok: false,
          error: err && err.message ? err.message : "Unexpected worker error"
        },
        500
      );
    }
  }
};

function normalisePath(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "");
  return path || "/";
}

function normaliseSku(value) {
  const sku = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!/^[A-Z0-9]{4,30}$/.test(sku)) return "";
  return sku;
}

function normaliseState(value) {
  const input = String(value || "all").trim().toUpperCase();

  if (input === "ALL") return "all";
  if (ALLOWED_STATES.has(input)) return input;

  return "all";
}

async function getStores(state = "all") {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/stores?state=${state}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const raw = await fetchJson(OW.stores, {
    cacheTtl: 43200
  });

  const sourceStores = Array.isArray(raw && raw.stores)
    ? raw.stores
    : Array.isArray(raw)
      ? raw
      : [];

  const stores = sourceStores
    .map(normaliseStore)
    .filter((store) => store.storeId && store.storeName);

  const filtered =
    state === "all"
      ? stores
      : stores.filter((store) => String(store.state || "").toUpperCase() === state);

  const response = new Response(JSON.stringify(filtered), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=43200"
    }
  });

  await cache.put(cacheKey, response.clone());
  return filtered;
}

function normaliseStore(store) {
  const addressObj = store && store.address ? store.address : {};
  const contactObj = store && store.contact ? store.contact : {};

  return {
    storeId: String(
      store.storeId ||
        store.id ||
        store.storeNumber ||
        store.locationId ||
        ""
    ),
    storeName: String(
      store.storeName ||
        store.name ||
        store.displayName ||
        ""
    ),
    address: String(
      addressObj.storeAddressLine ||
        addressObj.addressLine1 ||
        addressObj.address ||
        ""
    ),
    suburb: String(
      addressObj.storeCity ||
        addressObj.suburb ||
        addressObj.city ||
        ""
    ),
    state: String(
      addressObj.storeState ||
        addressObj.state ||
        ""
    ).toUpperCase(),
    postcode: String(
      addressObj.storePostcode ||
        addressObj.postcode ||
        ""
    ),
    phone: String(
      contactObj.storeTelephone ||
        contactObj.phone ||
        store.phone ||
        ""
    )
  };
}

async function getProduct(sku) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/product?sku=${sku}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  let data = null;

  try {
    data = await fetchJson(OW.productSearch + encodeURIComponent(sku), {
      cacheTtl: 3600
    });
  } catch (err) {
    data = null;
  }

  const products = Array.isArray(data && data.products) ? data.products : [];

  const exact = products.find((product) => {
    const partNumber = String(
      (product.identity && product.identity.partNumber) ||
        product.partNumber ||
        product.sku ||
        ""
    ).toUpperCase();

    return partNumber === sku;
  });

  const first = exact || products[0] || null;

  const product = {
    sku,
    name: String(
      (first && first.identity && first.identity.name) ||
        (first && first.name) ||
        sku
    ),
    partNumber: String(
      (first && first.identity && first.identity.partNumber) ||
        (first && first.partNumber) ||
        sku
    ),
    rawFound: Boolean(first)
  };

  const response = new Response(JSON.stringify(product), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });

  await cache.put(cacheKey, response.clone());
  return product;
}

async function getStockQty(storeId, sku) {
  const url = `${OW.availabilityBase}/${encodeURIComponent(
    storeId
  )}?partNumber=${encodeURIComponent(sku)}`;

  const data = await fetchJson(url, {
    cacheTtl: 0
  });

  return extractQty(data);
}

function extractQty(data) {
  const candidates = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (data && typeof data === "object") {
    candidates.push(data);
  }

  for (const item of candidates) {
    if (typeof item.qty === "number") return item.qty;
    if (typeof item.quantity === "number") return item.quantity;
    if (typeof item.stock === "number") return item.stock;

    const options = Array.isArray(item.options) ? item.options : [];

    for (const option of options) {
      const type = String(option.type || "").toLowerCase();

      if (
        type === "instore" ||
        type === "in_store" ||
        type === "in-store" ||
        type.includes("store")
      ) {
        const qty = Number(
          option.qty ??
            option.quantity ??
            option.stock ??
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

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/3.0"
    },
    cf:
      cacheTtl > 0
        ? {
            cacheTtl,
            cacheEverything: true
          }
        : {
            cacheTtl: 0
          }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Upstream returned non-JSON response: ${text.slice(0, 240)}`);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    {
      length: Math.min(limit, items.length)
    },
    () => runWorker()
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

function fallbackHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Stock Level Worker</title>
</head>
<body>
  <h1>Stock Level Worker is running.</h1>
  <p>Try <code>/api/health</code> or <code>/api/check?sku=IP1725MB&state=VIC</code>.</p>
</body>
</html>`;
}
