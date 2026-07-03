const VERSION = "2026-07-03-v13-store-postcode-fallback";

const OW = {
  stores: "https://www.officeworks.com.au/contact-us?view=stores&format=json",
  productSearch:
    "https://www.officeworks.com.au/shop/ProductSearchView?pageSize=50&langId=-1&catalogId=-1&storeId=10151&searchTerm=",
  availabilityBase:
    "https://www.officeworks.com.au/catalogue-app/api/availabilities/store"
};

const MAX_BATCH_SIZE = 20;

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
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (request.method !== "GET") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);
      const path = cleanPath(url.pathname);

      if (path.startsWith("/api/")) {
        return handleApi(url, path);
      }

      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return html(`<h1>Stock Level Worker ${VERSION}</h1>`, 200);
    } catch (err) {
      return json(
        {
          ok: false,
          version: VERSION,
          error: err && err.message ? err.message : "Unexpected Worker error"
        },
        500
      );
    }
  }
};

async function handleApi(url, path) {
  if (path === "/api/health") {
    return json({
      ok: true,
      version: VERSION,
      service: "officeworks-stock-worker",
      mode: "Nearest store count by postcode priority",
      currentAvailabilityApi:
        "/catalogue-app/api/availabilities/store/{storeId}/postcode/{postcode}?partNumbers={sku}",
      fix:
        "v13 uses each store's own postcode first for availability lookups, then falls back to the user's postcode.",
      time: new Date().toISOString()
    });
  }

  if (path === "/api/debug") {
    return json({
      ok: true,
      version: VERSION,
      maxBatchSize: MAX_BATCH_SIZE,
      note:
        "v13 fixes lookup errors when checking many stores by using store.postcode first and reducing upstream concurrency.",
      endpoints: OW
    });
  }

  if (path === "/api/stores") {
    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const maxStores = clampInt(url.searchParams.get("radiusKm"), 1, 999, 20);
    const resolvedState = resolveState(inputState, postcode);

    const result = await getStores({
      state: resolvedState,
      postcode,
      maxStores
    });

    return json({
      ok: true,
      version: VERSION,
      inputState,
      resolvedState,
      postcode,
      maxStores,
      count: result.stores.length,
      filterMode: result.filterMode,
      stores: result.stores
    });
  }

  if (path === "/api/store-search") {
    const query = String(url.searchParams.get("query") || "")
      .trim()
      .toLowerCase();

    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const resolvedState = resolveState(inputState, postcode);

    if (!query) {
      return json(
        {
          ok: false,
          error: "Missing query. Example: /api/store-search?query=Carnegie"
        },
        400
      );
    }

    const result = await getStores({
      state: resolvedState,
      postcode,
      maxStores: 999
    });

    const stores = result.stores.filter((store) => {
      const haystack = [
        store.storeName,
        store.address,
        store.suburb,
        store.state,
        store.postcode,
        store.storeId
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });

    return json({
      ok: true,
      version: VERSION,
      query,
      inputState,
      resolvedState,
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

  if (path === "/api/raw") {
    const sku = normaliseSku(url.searchParams.get("sku"));
    const storeId = String(url.searchParams.get("storeId") || "")
      .trim()
      .toUpperCase();
    const postcode = normalisePostcode(url.searchParams.get("postcode")) || "3161";

    if (!sku || !storeId) {
      return json(
        {
          ok: false,
          error:
            "Missing sku or storeId. Example: /api/raw?sku=JBAALR618B&storeId=W345&postcode=3161"
        },
        400
      );
    }

    const raw = await fetchAvailabilityRaw(storeId, postcode, sku);
    const parsed = parseCurrentAvailability(raw, sku);

    return json({
      ok: true,
      version: VERSION,
      sku,
      storeId,
      postcode,
      parsed,
      raw
    });
  }

  if (path === "/api/check") {
    const sku = normaliseSku(url.searchParams.get("sku"));
    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const userPostcode = normalisePostcode(url.searchParams.get("postcode"));
    const maxStores = clampInt(url.searchParams.get("radiusKm"), 1, 999, 20);
    const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);
    const limit = clampInt(
      url.searchParams.get("limit"),
      1,
      MAX_BATCH_SIZE,
      MAX_BATCH_SIZE
    );
    const resolvedState = resolveState(inputState, userPostcode);

    if (!sku) {
      return json({ ok: false, error: "Missing or invalid sku" }, 400);
    }

    const startedAt = Date.now();

    const [product, storeResult] = await Promise.all([
      getProduct(sku),
      getStores({
        state: resolvedState,
        postcode: userPostcode,
        maxStores
      })
    ]);

    const stores = storeResult.stores;
    const totalStores = stores.length;
    const batchStores = stores.slice(offset, offset + limit);
    const nextOffset = offset + batchStores.length;
    const hasMore = nextOffset < totalStores;

    const rows = await mapLimit(batchStores, 2, async (store) => {
      let parsed = {
        qty: 0,
        inStoreQuantity: 0,
        clickAndCollectQuantity: 0,
        deliveryQuantity: 0,
        status: "no_stock",
        source: "none",
        rawSignal: ""
      };

      let error = "";
      let lookupPostcode = store.postcode || userPostcode || "3000";

      try {
        const result = await fetchAvailabilityWithFallback({
          storeId: store.storeId,
          storePostcode: store.postcode,
          userPostcode,
          sku
        });

        parsed = result.parsed;
        lookupPostcode = result.postcodeUsed;
      } catch (err) {
        parsed = {
          qty: null,
          inStoreQuantity: null,
          clickAndCollectQuantity: null,
          deliveryQuantity: null,
          status: "error",
          source: "error",
          rawSignal: ""
        };
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
        lookupPostcode,
        distanceKm: null,
        distanceSource: store.distanceSource,
        postcodeScore: store.postcodeScore,
        sku,
        qty: parsed.qty,
        inStoreQuantity: parsed.inStoreQuantity,
        clickAndCollectQuantity: parsed.clickAndCollectQuantity,
        deliveryQuantity: parsed.deliveryQuantity,
        status: parsed.status,
        source: parsed.source,
        rawSignal: parsed.rawSignal,
        collectEstimation: parsed.collectEstimation,
        deliveryEstimation: parsed.deliveryEstimation,
        error
      };
    });

    rows.sort((a, b) => {
      const ad = sortDistanceValue(a);
      const bd = sortDistanceValue(b);

      if (ad !== bd) return ad - bd;

      const aq = stockSortValue(a);
      const bq = stockSortValue(b);

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
      inputState,
      resolvedState,
      postcode: userPostcode,
      maxStores,
      filterMode: storeResult.filterMode,
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
      version: VERSION,
      error: "API route not found",
      path
    },
    404
  );
}

async function fetchAvailabilityWithFallback({ storeId, storePostcode, userPostcode, sku }) {
  const candidates = [];

  if (normalisePostcode(storePostcode)) candidates.push(normalisePostcode(storePostcode));
  if (normalisePostcode(userPostcode)) candidates.push(normalisePostcode(userPostcode));
  if (!candidates.length) candidates.push("3000");

  const uniquePostcodes = Array.from(new Set(candidates));

  let lastError = null;

  for (const postcode of uniquePostcodes) {
    try {
      const raw = await fetchAvailabilityRaw(storeId, postcode, sku);
      const parsed = parseCurrentAvailability(raw, sku);

      return {
        postcodeUsed: postcode,
        raw,
        parsed
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Availability lookup failed");
}

async function fetchAvailabilityRaw(storeId, postcode, sku) {
  const url =
    `${OW.availabilityBase}/${encodeURIComponent(storeId)}` +
    `/postcode/${encodeURIComponent(postcode)}` +
    `?partNumbers=${encodeURIComponent(sku)}`;

  return fetchJson(url, {
    cacheTtl: 0,
    label: `current availability ${storeId}/${postcode}/${sku}`
  });
}

function parseCurrentAvailability(raw, sku) {
  const items = Array.isArray(raw) ? raw : [raw];

  const target =
    items.find((item) => String(item && item.sku).toUpperCase() === sku) ||
    items[0] ||
    null;

  if (!target || typeof target !== "object") {
    return {
      qty: 0,
      inStoreQuantity: 0,
      clickAndCollectQuantity: 0,
      deliveryQuantity: 0,
      status: "no_stock",
      source: "current:empty-response",
      rawSignal: "No availability object returned"
    };
  }

  const inStoreQuantity = parseQty(target.inStoreQuantity) || 0;
  const clickAndCollectQuantity = parseQty(target.clickAndCollectQuantity) || 0;
  const deliveryQuantity = parseQty(target.deliveryQuantity) || 0;

  const qty = Math.max(inStoreQuantity, clickAndCollectQuantity);

  return {
    qty,
    inStoreQuantity,
    clickAndCollectQuantity,
    deliveryQuantity,
    status: qty > 0 ? "in_stock" : "no_stock",
    source:
      "current:catalogue-app/api/availabilities/store/{storeId}/postcode/{postcode}",
    rawSignal:
      `inStore=${inStoreQuantity}, clickAndCollect=${clickAndCollectQuantity}, delivery=${deliveryQuantity}`,
    collectEstimation: target.collectEstimation || "",
    deliveryEstimation: target.deliveryEstimation || ""
  };
}

async function getProduct(sku) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/product-v13?sku=${sku}`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  let data = null;

  try {
    data = await fetchJson(OW.productSearch + encodeURIComponent(sku), {
      cacheTtl: 3600,
      label: "Officeworks product search"
    });
  } catch {
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

async function getStores({ state = "all", postcode = "", maxStores = 20 } = {}) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/stores-v13?state=${state}`);

  let stores;

  const cached = await cache.match(cacheKey);

  if (cached) {
    stores = await cached.json();
  } else {
    const raw = await fetchJson(OW.stores, {
      cacheTtl: 43200,
      label: "Officeworks stores"
    });

    const sourceStores = Array.isArray(raw && raw.stores)
      ? raw.stores
      : Array.isArray(raw)
        ? raw
        : [];

    stores = sourceStores
      .map(normaliseStore)
      .filter((store) => store.storeId && store.storeName);

    if (state !== "all") {
      stores = stores.filter(
        (store) => String(store.state || "").toUpperCase() === state
      );
    }

    const response = new Response(JSON.stringify(stores), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=43200"
      }
    });

    await cache.put(cacheKey, response.clone());
  }

  if (!postcode) {
    const sliced = maxStores >= 999 ? stores : stores.slice(0, maxStores);

    return {
      stores: sliced.map((store, index) => ({
        ...store,
        distanceKm: null,
        distanceSource: "state-order",
        postcodeScore: index
      })),
      filterMode: maxStores >= 999 ? "all-stores-in-state" : "state-order-limit"
    };
  }

  const sortedStores = stores
    .map((store) => {
      const score = postcodeScore(postcode, store.postcode);

      return {
        ...store,
        distanceKm: null,
        distanceSource: "nearest-postcode-priority",
        postcodeScore: score
      };
    })
    .sort((a, b) => {
      const as = typeof a.postcodeScore === "number" ? a.postcodeScore : 999999;
      const bs = typeof b.postcodeScore === "number" ? b.postcodeScore : 999999;

      return as - bs || String(a.storeName).localeCompare(String(b.storeName));
    });

  const limitedStores = maxStores >= 999 ? sortedStores : sortedStores.slice(0, maxStores);

  return {
    stores: limitedStores,
    filterMode: maxStores >= 999 ? "all-stores-postcode-priority" : "nearest-postcode-priority"
  };
}

function normaliseStore(store) {
  const addressObj = store && store.address ? store.address : {};
  const contactObj = store && store.contact ? store.contact : {};

  return {
    storeId: String(
      store.storeId || store.id || store.storeNumber || store.locationId || ""
    )
      .trim()
      .toUpperCase(),
    storeName: decodeHtml(
      String(store.storeName || store.name || store.displayName || "")
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
      String(addressObj.storeCity || addressObj.suburb || addressObj.city || "")
    ),
    state: String(addressObj.storeState || addressObj.state || "").toUpperCase(),
    postcode: String(addressObj.storePostcode || addressObj.postcode || ""),
    phone: String(contactObj.storeTelephone || contactObj.phone || store.phone || "")
  };
}

function cleanPath(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "");
  return path || "/";
}

function normaliseSku(value) {
  const sku = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  return /^[A-Z0-9]{4,30}$/.test(sku) ? sku : "";
}

function normaliseState(value) {
  const input = String(value || "all").trim().toUpperCase();

  if (input === "ALL") return "all";
  if (ALLOWED_STATES.has(input)) return input;

  return "all";
}

function normalisePostcode(value) {
  const postcode = String(value || "").trim().replace(/[^0-9]/g, "");
  return /^[0-9]{4}$/.test(postcode) ? postcode : "";
}

function resolveState(inputState, postcode) {
  if (inputState !== "all") return inputState;
  return inferStateFromPostcode(postcode) || inputState;
}

function inferStateFromPostcode(postcode) {
  const pc = Number(postcode);

  if (!Number.isFinite(pc)) return "";

  if (
    (pc >= 1000 && pc <= 1999) ||
    (pc >= 2000 && pc <= 2599) ||
    (pc >= 2619 && pc <= 2899) ||
    (pc >= 2921 && pc <= 2999)
  ) {
    return "NSW";
  }

  if (
    (pc >= 200 && pc <= 299) ||
    (pc >= 2600 && pc <= 2618) ||
    (pc >= 2900 && pc <= 2920)
  ) {
    return "ACT";
  }

  if ((pc >= 3000 && pc <= 3999) || (pc >= 8000 && pc <= 8999)) return "VIC";
  if ((pc >= 4000 && pc <= 4999) || (pc >= 9000 && pc <= 9999)) return "QLD";
  if (pc >= 5000 && pc <= 5999) return "SA";
  if (pc >= 6000 && pc <= 6999) return "WA";
  if (pc >= 7000 && pc <= 7999) return "TAS";
  if (pc >= 800 && pc <= 999) return "NT";

  return "";
}

function postcodeScore(targetPostcode, storePostcode) {
  const a = Number(targetPostcode);
  const b = Number(String(storePostcode || "").replace(/[^0-9]/g, ""));

  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999999;

  return Math.abs(a - b);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseQty(value) {
  if (value === null || typeof value === "undefined") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    const direct = Number(trimmed);
    if (Number.isFinite(direct)) return direct;

    const match = trimmed.match(/\d+/);
    if (match) {
      const n = Number(match[0]);
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function stockSortValue(row) {
  if (!row) return 0;
  const qty = Number(row.qty || 0);
  return Number.isFinite(qty) ? qty : 0;
}

function sortDistanceValue(row) {
  if (!row) return 999999;
  if (typeof row.postcodeScore === "number") return row.postcodeScore;
  return 999999;
}

async function fetchJson(url, options = {}) {
  const cacheTtl = Number(options.cacheTtl || 0);
  const label = options.label || "upstream";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/13.0",
      "Referer": "https://www.officeworks.com.au/",
      "Origin": "https://www.officeworks.com.au"
    },
    cf:
      cacheTtl > 0
        ? { cacheTtl, cacheEverything: true }
        : { cacheTtl: 0 }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label} upstream HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 240)}`);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );

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
