const VERSION = "2026-07-03-v8-store-filter-fallback";

const OW = {
  stores: "https://www.officeworks.com.au/contact-us?view=stores&format=json",
  productSearch:
    "https://www.officeworks.com.au/shop/ProductSearchView?pageSize=50&langId=-1&catalogId=-1&storeId=10151&searchTerm=",
  availabilityBase: "https://api.officeworks.com.au/v2/availability/store"
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
        return handleApi(request, env, url, path);
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

async function handleApi(request, env, url, path) {
  if (path === "/api/health") {
    return json({
      ok: true,
      version: VERSION,
      service: "officeworks-stock-worker",
      hasAssetsBinding: Boolean(env && env.ASSETS),
      time: new Date().toISOString()
    });
  }

  if (path === "/api/debug") {
    return json({
      ok: true,
      version: VERSION,
      maxBatchSize: MAX_BATCH_SIZE,
      parser:
        "Legacy-first parser: availability[0].options[] where type === inStore and qty > 0.",
      storeFilter:
        "If store coordinates are unavailable, postcode mode falls back to postcode sorting instead of filtering all stores out.",
      endpoints: OW,
      time: new Date().toISOString()
    });
  }

  if (path === "/api/stores") {
    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const radiusKm = clampNumber(url.searchParams.get("radiusKm"), 1, 250, 25);
    const resolvedState = resolveState(inputState, postcode);

    const result = await getStores({
      state: resolvedState,
      postcode,
      radiusKm
    });

    return json({
      ok: true,
      version: VERSION,
      inputState,
      resolvedState,
      postcode,
      radiusKm,
      count: result.stores.length,
      filterMode: result.filterMode,
      stores: result.stores
    });
  }

  if (path === "/api/store-search") {
    const query = String(url.searchParams.get("query") || "").trim().toLowerCase();
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

    const result = await getStores({ state: resolvedState });

    const matches = result.stores.filter((store) => {
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
      count: matches.length,
      stores: matches
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
    const storeId = String(url.searchParams.get("storeId") || "").trim().toUpperCase();

    if (!sku || !storeId) {
      return json(
        {
          ok: false,
          error:
            "Missing sku or storeId. Example: /api/raw?sku=JBAALR618B&storeId=W411"
        },
        400
      );
    }

    const raw = await fetchAvailabilityRaw(storeId, sku);
    const parsed = parseAvailabilityLegacyFirst(raw);

    return json({
      ok: true,
      version: VERSION,
      sku,
      storeId,
      parsed,
      raw
    });
  }

  if (path === "/api/check") {
    const sku = normaliseSku(url.searchParams.get("sku"));
    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const radiusKm = clampNumber(url.searchParams.get("radiusKm"), 1, 250, 25);
    const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);
    const limit = clampInt(url.searchParams.get("limit"), 1, MAX_BATCH_SIZE, MAX_BATCH_SIZE);
    const resolvedState = resolveState(inputState, postcode);

    if (!sku) {
      return json({ ok: false, error: "Missing or invalid sku" }, 400);
    }

    const startedAt = Date.now();

    const [product, storeResult] = await Promise.all([
      getProduct(sku),
      getStores({
        state: resolvedState,
        postcode,
        radiusKm
      })
    ]);

    const stores = storeResult.stores;
    const totalStores = stores.length;
    const batchStores = stores.slice(offset, offset + limit);
    const nextOffset = offset + batchStores.length;
    const hasMore = nextOffset < totalStores;

    const rows = await mapLimit(batchStores, 4, async (store) => {
      let parsed = {
        qty: 0,
        status: "no_stock",
        source: "none",
        rawSignal: ""
      };

      let error = "";

      try {
        const raw = await fetchAvailabilityRaw(store.storeId, sku);
        parsed = parseAvailabilityLegacyFirst(raw);
      } catch (err) {
        parsed = {
          qty: null,
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
        lat: store.lat,
        lng: store.lng,
        distanceKm: store.distanceKm,
        distanceSource: store.distanceSource,
        postcodeScore: store.postcodeScore,
        qty: parsed.qty,
        status: parsed.status,
        source: parsed.source,
        rawSignal: parsed.rawSignal,
        options: parsed.options || [],
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
      postcode,
      radiusKm,
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

  const inferred = inferStateFromPostcode(postcode);

  return inferred || inputState;
}

function inferStateFromPostcode(postcode) {
  const pc = Number(postcode);

  if (!Number.isFinite(pc)) return "";

  if ((pc >= 1000 && pc <= 1999) || (pc >= 2000 && pc <= 2599) || (pc >= 2619 && pc <= 2899) || (pc >= 2921 && pc <= 2999)) return "NSW";
  if ((pc >= 200 && pc <= 299) || (pc >= 2600 && pc <= 2618) || (pc >= 2900 && pc <= 2920)) return "ACT";
  if ((pc >= 3000 && pc <= 3999) || (pc >= 8000 && pc <= 8999)) return "VIC";
  if ((pc >= 4000 && pc <= 4999) || (pc >= 9000 && pc <= 9999)) return "QLD";
  if (pc >= 5000 && pc <= 5999) return "SA";
  if (pc >= 6000 && pc <= 6999) return "WA";
  if (pc >= 7000 && pc <= 7999) return "TAS";
  if (pc >= 800 && pc <= 999) return "NT";

  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(String(value ?? ""));

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

async function getStores({ state = "all", postcode = "", radiusKm = 25 } = {}) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/stores-v8?state=${state}`);

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
      stores = stores.filter((store) => String(store.state || "").toUpperCase() === state);
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
    return {
      stores,
      filterMode: state === "all" ? "all-states" : "state-only"
    };
  }

  const hasEnoughCoords =
    stores.filter((store) => typeof store.lat === "number" && typeof store.lng === "number").length >=
    Math.max(3, Math.ceil(stores.length * 0.5));

  if (hasEnoughCoords) {
    const centre = await geocodePostcode(postcode);

    const radiusStores = stores
      .map((store) => {
        if (typeof store.lat !== "number" || typeof store.lng !== "number") {
          return {
            ...store,
            distanceKm: null,
            distanceSource: "missing-store-coordinates"
          };
        }

        return {
          ...store,
          distanceKm: round1(distanceKm(centre.lat, centre.lng, store.lat, store.lng)),
          distanceSource: "latlng"
        };
      })
      .filter((store) => typeof store.distanceKm === "number" && store.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (radiusStores.length) {
      return {
        stores: radiusStores,
        filterMode: "exact-radius"
      };
    }
  }

  const fallbackStores = stores
    .map((store) => {
      const score = postcodeScore(postcode, store.postcode);

      return {
        ...store,
        distanceKm: null,
        distanceSource: "postcode-sort-fallback",
        postcodeScore: score
      };
    })
    .sort((a, b) => {
      const as = typeof a.postcodeScore === "number" ? a.postcodeScore : 999999;
      const bs = typeof b.postcodeScore === "number" ? b.postcodeScore : 999999;

      return as - bs || String(a.storeName).localeCompare(String(b.storeName));
    });

  return {
    stores: fallbackStores,
    filterMode: "postcode-sort-fallback"
  };
}

function postcodeScore(targetPostcode, storePostcode) {
  const a = Number(targetPostcode);
  const b = Number(String(storePostcode || "").replace(/[^0-9]/g, ""));

  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999999;

  return Math.abs(a - b);
}

function normaliseStore(store) {
  const addressObj = store && store.address ? store.address : {};
  const contactObj = store && store.contact ? store.contact : {};

  const lat = firstNumber([
    store.latitude,
    store.lat,
    store.storeLatitude,
    store.geoLat,
    store.geoLatitude,
    store.gpsLatitude,
    store.storeLat,
    addressObj.latitude,
    addressObj.lat,
    addressObj.storeLatitude,
    addressObj.storeLat
  ]);

  const lng = firstNumber([
    store.longitude,
    store.lng,
    store.lon,
    store.long,
    store.storeLongitude,
    store.geoLng,
    store.geoLongitude,
    store.gpsLongitude,
    store.storeLng,
    store.storeLong,
    addressObj.longitude,
    addressObj.lng,
    addressObj.lon,
    addressObj.storeLongitude,
    addressObj.storeLng
  ]);

  return {
    storeId: String(
      store.storeId ||
        store.id ||
        store.storeNumber ||
        store.locationId ||
        ""
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
    phone: String(
      contactObj.storeTelephone || contactObj.phone || store.phone || ""
    ),
    lat,
    lng
  };
}

function firstNumber(values) {
  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

async function geocodePostcode(postcode) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/postcode-v8/${postcode}`);

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const url = `https://api.zippopotam.us/AU/${encodeURIComponent(postcode)}`;
  const data = await fetchJson(url, {
    cacheTtl: 86400,
    label: `postcode geocode ${postcode}`
  });

  const place = Array.isArray(data.places) ? data.places[0] : null;

  const centre = {
    postcode,
    lat: Number(place && place.latitude),
    lng: Number(place && place.longitude)
  };

  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) {
    throw new Error(`Could not geocode postcode ${postcode}`);
  }

  const response = new Response(JSON.stringify(centre), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400"
    }
  });

  await cache.put(cacheKey, response.clone());

  return centre;
}

async function getProduct(sku) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/product-v8?sku=${sku}`);

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

async function fetchAvailabilityRaw(storeId, sku) {
  const url = `${OW.availabilityBase}/${encodeURIComponent(
    storeId
  )}?partNumber=${encodeURIComponent(sku)}`;

  return fetchJson(url, {
    cacheTtl: 0,
    label: `availability ${storeId}/${sku}`
  });
}

function parseAvailabilityLegacyFirst(raw) {
  const primary = Array.isArray(raw) ? raw[0] : raw;

  const options = Array.isArray(primary && primary.options)
    ? primary.options
    : [];

  const simplifiedOptions = options.map((option) => ({
    type: String(option.type || ""),
    qty: parseQty(option.qty),
    rawQty: option.qty,
    deliveryMethod:
      option.deliveryMethod ||
      option.fulfilmentType ||
      option.fulfillmentType ||
      "",
    status: option.status || option.availability || ""
  }));

  const inStoreOption = options.find((option) => {
    return String(option.type || "").toLowerCase() === "instore";
  });

  if (inStoreOption) {
    const qty = parseQty(inStoreOption.qty);

    return {
      qty: qty === null ? 0 : qty,
      status: qty !== null && qty > 0 ? "in_stock" : "no_stock",
      source: "legacy:availability[0].options[type=inStore].qty",
      rawSignal: `inStore qty=${qty === null ? "null" : qty}`,
      options: simplifiedOptions
    };
  }

  const lowerTypeStoreOption = options.find((option) => {
    const type = String(option.type || "").toLowerCase();
    return type.includes("store") || type.includes("pickup") || type.includes("collect");
  });

  if (lowerTypeStoreOption) {
    const qty = parseQty(lowerTypeStoreOption.qty);

    return {
      qty: qty === null ? 0 : qty,
      status: qty !== null && qty > 0 ? "in_stock" : "no_stock",
      source: "fallback:store-like option qty",
      rawSignal: `store-like option qty=${qty === null ? "null" : qty}`,
      options: simplifiedOptions
    };
  }

  return parseAvailabilityRecursiveFallback(raw, simplifiedOptions);
}

function parseAvailabilityRecursiveFallback(raw, simplifiedOptions) {
  const objects = flattenObjects(raw);

  let bestQty = 0;
  let sawQty = false;
  const signals = [];

  for (const obj of objects) {
    const typeText = [
      obj.type,
      obj.fulfilmentType,
      obj.fulfillmentType,
      obj.deliveryMode,
      obj.channel,
      obj.option,
      obj.name,
      obj.label
    ]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");

    const jsonText = JSON.stringify(obj).toLowerCase();

    const storeRelevant =
      typeText.includes("store") ||
      typeText.includes("pickup") ||
      typeText.includes("collect") ||
      jsonText.includes("instore") ||
      jsonText.includes("in-store") ||
      jsonText.includes("click and collect") ||
      jsonText.includes("pickup");

    if (!storeRelevant) continue;

    const qtyKeys = [
      "qty",
      "quantity",
      "stock",
      "availableQuantity",
      "availableQty",
      "stockLevel",
      "onHand",
      "onHandQty",
      "storeStock",
      "storeQuantity",
      "ats",
      "availableToSell"
    ];

    for (const key of qtyKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const qty = parseQty(obj[key]);

        if (qty !== null) {
          sawQty = true;
          bestQty = Math.max(bestQty, qty);

          if (qty > 0) {
            signals.push(`${key}:${qty}`);
          }
        }
      }
    }
  }

  return {
    qty: sawQty ? bestQty : 0,
    status: sawQty && bestQty > 0 ? "in_stock" : "no_stock",
    source: "recursive-store-fallback",
    rawSignal: uniqueSignals(signals).join(", "),
    options: simplifiedOptions
  };
}

function flattenObjects(value) {
  const out = [];

  function walk(v) {
    if (!v || typeof v !== "object") return;

    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }

    out.push(v);

    for (const key of Object.keys(v)) {
      walk(v[key]);
    }
  }

  walk(value);

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

    if (Number.isFinite(direct)) return direct;

    const match = trimmed.match(/\d+/);

    if (match) {
      const n = Number(match[0]);

      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function uniqueSignals(signals) {
  return Array.from(new Set(signals.filter(Boolean))).slice(0, 8);
}

function stockSortValue(row) {
  if (!row) return 0;

  const qty = Number(row.qty || 0);

  return Number.isFinite(qty) ? qty : 0;
}

function sortDistanceValue(row) {
  if (!row) return 999999;

  if (typeof row.distanceKm === "number") {
    return row.distanceKm;
  }

  if (typeof row.postcodeScore === "number") {
    return row.postcodeScore;
  }

  return 999999;
}

async function fetchJson(url, options = {}) {
  const cacheTtl = Number(options.cacheTtl || 0);
  const label = options.label || "upstream";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/8.0",
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

function distanceKm(lat1, lng1, lat2, lng2) {
  const r = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLng = deg2rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function round1(n) {
  return Math.round(n * 10) / 10;
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