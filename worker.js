const VERSION = "2026-07-03-v5-batched";

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

const MAX_BATCH_SIZE = 35;

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
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);
      const path = normalisePath(url.pathname);

      if (path.startsWith("/api/")) {
        return handleApi(request, env, url, path);
      }

      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return html(fallbackHtml(), 200);
    } catch (err) {
      return json(
        {
          ok: false,
          error: err && err.message ? err.message : "Unexpected worker error",
          version: VERSION
        },
        500
      );
    }
  }
};

async function handleApi(request, env, url, path) {
  if (path === "/api/health") {
    return json({
      ok: true,
      service: "officeworks-stock-worker",
      worker: "stock-level",
      version: VERSION,
      hasAssetsBinding: Boolean(env && env.ASSETS),
      time: new Date().toISOString()
    });
  }

  if (path === "/api/debug") {
    return json({
      ok: true,
      version: VERSION,
      maxBatchSize: MAX_BATCH_SIZE,
      hasAssetsBinding: Boolean(env && env.ASSETS),
      workersDevNote:
        "Free Workers are limited to 50 external subrequests per invocation, so stock checks are batched.",
      endpoints: OW,
      time: new Date().toISOString()
    });
  }

  if (path === "/api/stores") {
    const state = normaliseState(url.searchParams.get("state") || "all");
    const stores = await getStores(state);

    return json({
      ok: true,
      version: VERSION,
      state,
      count: stores.length,
      stores
    });
  }

  if (path === "/api/product") {
    const sku = normaliseSku(url.searchParams.get("sku"));

    if (!sku) {
      return json({ ok: false, error: "Missing or invalid sku" }, 400);
    }

    const product = await getProduct(sku);

    return json({
      ok: true,
      version: VERSION,
      product
    });
  }

  if (path === "/api/check") {
    const sku = normaliseSku(url.searchParams.get("sku"));
    const state = normaliseState(url.searchParams.get("state") || "all");
    const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);
    const requestedLimit = clampInt(url.searchParams.get("limit"), 1, MAX_BATCH_SIZE, MAX_BATCH_SIZE);
    const limit = Math.min(requestedLimit, MAX_BATCH_SIZE);

    if (!sku) {
      return json({ ok: false, error: "Missing or invalid sku" }, 400);
    }

    const startedAt = Date.now();

    const [product, stores] = await Promise.all([
      getProduct(sku),
      getStores(state)
    ]);

    const totalStores = stores.length;
    const batchStores = stores.slice(offset, offset + limit);
    const nextOffset = offset + batchStores.length;
    const hasMore = nextOffset < totalStores;

    const rows = await mapLimit(batchStores, 5, async (store) => {
      let qty = null;
      let status = "unknown";
      let error = "";
      let rawSignal = "";

      try {
        const availability = await getStockAvailability(store.storeId, sku);
        qty = availability.qty;
        rawSignal = availability.rawSignal || "";

        if (qty === null || typeof qty === "undefined") {
          status = availability.available ? "in_stock" : "unknown";
        } else {
          status = Number(qty) > 0 ? "in_stock" : "no_stock";
        }
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
        rawSignal,
        error
      };
    });

    rows.sort((a, b) => {
      const aq = qtyForSort(a);
      const bq = qtyForSort(b);
      return bq - aq || String(a.storeName).localeCompare(String(b.storeName));
    });

    const storesWithStock = rows.filter((row) => row.status === "in_stock").length;

    const totalVisibleStock = rows.reduce((sum, row) => {
      const qty = Number(row.qty || 0);
      return Number.isFinite(qty) ? sum + qty : sum;
    }, 0);

    const lookupErrors = rows.filter((row) => row.status === "error").length;

    return json({
      ok: true,
      version: VERSION,
      product,
      state,
      paging: {
        offset,
        limit,
        returned: rows.length,
        nextOffset,
        hasMore,
        totalStores
      },
      summary: {
        storesChecked: rows.length,
        storesWithStock,
        totalVisibleStock,
        lookupErrors,
        durationMs: Date.now() - startedAt
      },
      rows
    });
  }

  return json(
    {
      ok: false,
      error: "API route not found",
      path,
      version: VERSION
    },
    404
  );
}

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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

async function getStores(state = "all") {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/stores?state=${state}`);

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const raw = await fetchJson(OW.stores, {
    cacheTtl: 43200,
    label: "Officeworks stores"
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
    storeName: decodeHtml(
      String(
        store.storeName ||
          store.name ||
          store.displayName ||
          ""
      )
    ),
    address: decodeHtml(
      String(
        addressObj.storeAddressLine ||
          addressObj.addressLine1 ||
          addressObj.address ||
          ""
      )
    ),
    suburb: decodeHtml(
      String(
        addressObj.storeCity ||
          addressObj.suburb ||
          addressObj.city ||
          ""
      )
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
      cacheTtl: 3600,
      label: "Officeworks product search"
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
    name: decodeHtml(
      String(
        (first && first.identity && first.identity.name) ||
          (first && first.name) ||
          sku
      )
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

async function getStockAvailability(storeId, sku) {
  const url = `${OW.availabilityBase}/${encodeURIComponent(
    storeId
  )}?partNumber=${encodeURIComponent(sku)}`;

  const data = await fetchJson(url, {
    cacheTtl: 0,
    label: `Officeworks availability store ${storeId}`
  });

  return extractAvailability(data);
}

function extractAvailability(data) {
  const flat = flattenAvailability(data);

  let bestQty = null;
  let available = false;
  let rawSignal = "";

  for (const item of flat) {
    const fields = [
      item.qty,
      item.quantity,
      item.stock,
      item.availableQuantity,
      item.availableQty,
      item.stockLevel,
      item.onHand,
      item.onHandQty,
      item.storeStock,
      item.storeQuantity
    ];

    for (const field of fields) {
      const qty = parseQty(field);

      if (qty !== null) {
        bestQty = Math.max(bestQty ?? 0, qty);

        if (qty > 0) {
          available = true;
        }
      }
    }

    const textBlob = JSON.stringify(item).toLowerCase();

    if (
      textBlob.includes("in stock") ||
      textBlob.includes("available") ||
      textBlob.includes("collect today") ||
      textBlob.includes("click and collect")
    ) {
      available = true;
      rawSignal = rawSignal || "availability text signal";
    }

    if (
      textBlob.includes("out of stock") ||
      textBlob.includes("unavailable")
    ) {
      rawSignal = rawSignal || "unavailable text signal";
    }
  }

  if (available && (bestQty === null || bestQty === 0)) {
    return {
      qty: bestQty,
      available: true,
      rawSignal: rawSignal || "available without visible quantity"
    };
  }

  return {
    qty: bestQty === null ? 0 : bestQty,
    available,
    rawSignal
  };
}

function flattenAvailability(data) {
  const out = [];

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    out.push(value);

    for (const key of Object.keys(value)) {
      const child = value[key];

      if (child && typeof child === "object") {
        walk(child);
      }
    }
  }

  walk(data);

  return out;
}

function parseQty(value) {
  if (value === null || typeof value === "undefined") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) return null;

    const direct = Number(trimmed);

    if (Number.isFinite(direct)) {
      return direct;
    }

    const match = trimmed.match(/\d+/);

    if (match) {
      const n = Number(match[0]);

      if (Number.isFinite(n)) {
        return n;
      }
    }
  }

  return null;
}

function qtyForSort(row) {
  if (!row) return -1;
  if (row.status === "in_stock" && (row.qty === null || typeof row.qty === "undefined")) return 1;

  const qty = Number(row.qty || 0);

  if (!Number.isFinite(qty)) return 0;

  return qty;
}

async function fetchJson(url, options = {}) {
  const cacheTtl = Number(options.cacheTtl || 0);
  const label = options.label || "upstream";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/5.0",
      "Referer": "https://www.officeworks.com.au/"
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
    throw new Error(`${label} upstream HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 240)}`);
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

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
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
  <p>Try <code>/api/health</code> or <code>/api/check?sku=KEJITAPECLR&state=all&offset=0&limit=35</code>.</p>
  <p>Version: ${VERSION}</p>
</body>
</html>`;
}
