import {
  APPLE_BASE,
  FAMILIES as APPLE_FAMILIES,
  STORES as APPLE_STORES,
  STORE_BY_ID as APPLE_STORE_BY_ID,
  describePart,
  pickAnchors,
  productUrl,
  resolveStores,
  selectParts
} from "./src/apple/catalog-au.mjs";
import { fetchFulfillment, scanStores } from "./src/apple/fulfillment.mjs";
import { AppleWatcher } from "./src/apple/watcher.mjs";
import {
  OW,
  fetchAvailabilityRaw,
  fetchJson,
  mapLimit,
  parseCurrentAvailability,
  parseQty
} from "./src/officeworks/client.mjs";
import { resolveOrigin, storesWithinRadius } from "./src/officeworks/geo.mjs";
import { WatchHub } from "./src/officeworks/watch-hub.mjs";

export { AppleWatcher, WatchHub };

const VERSION = "2026-10-28-v18-ow-alerts";

const APPLE_CHECK_CACHE_SECONDS = 20;

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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      const url = new URL(request.url);
      const path = cleanPath(url.pathname);

      if (request.method === "POST" && POST_ROUTES.has(path)) {
        return handlePost(request, path, env);
      }

      if (request.method !== "GET") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      if (path.startsWith("/api/")) {
        return handleApi(url, path, env);
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
  },

  // Cron: re-check Officeworks restock alerts (and keep the Apple watcher's
  // alarm loop running if that is enabled).
  async scheduled(event, env, ctx) {
    if (env && env.WATCH_HUB) {
      ctx.waitUntil(watchHubStub(env).fetch("https://watch-hub/run", { method: "POST", body: "{}" }));
    }
    if (env && env.APPLE_WATCHER) {
      ctx.waitUntil(appleWatcherStub(env).fetch("https://apple-watcher/ensure"));
    }
  }
};

const POST_ROUTES = new Set(["/api/alerts", "/api/telegram/webhook"]);
const MAX_POST_BYTES = 8192;

function watchHubStub(env) {
  return env.WATCH_HUB.get(env.WATCH_HUB.idFromName("officeworks"));
}

async function forwardToHub(env, path, init) {
  const res = await watchHubStub(env).fetch(`https://watch-hub${path}`, init);
  const payload = await res.json();
  return json({ version: VERSION, ...payload }, res.status);
}

async function handlePost(request, path, env) {
  if (!env || !env.WATCH_HUB) {
    return json({ ok: false, error: "Alerts are not configured" }, 503);
  }

  const text = await request.text();
  if (text.length > MAX_POST_BYTES) {
    return json({ ok: false, error: "Request too large" }, 413);
  }

  // Telegram -> bot webhook. Telegram echoes the secret set in setWebhook.
  if (path === "/api/telegram/webhook") {
    const secret = env.TELEGRAM_WEBHOOK_SECRET || "";
    if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    await watchHubStub(env).fetch("https://watch-hub/telegram", { method: "POST", body: text });
    // Always 200 so Telegram does not retry the same update.
    return json({ ok: true });
  }

  // Page -> create a restock alert.
  return forwardToHub(env, "/create", { method: "POST", body: text });
}

function appleWatcherStub(env) {
  return env.APPLE_WATCHER.get(env.APPLE_WATCHER.idFromName("au"));
}

async function handleApi(url, path, env) {
  if (path.startsWith("/api/apple/")) {
    return handleAppleApi(url, path, env);
  }

  if (path === "/api/alerts/config") {
    if (!env || !env.WATCH_HUB) return json({ ok: true, version: VERSION, enabled: false });
    return forwardToHub(env, "/config");
  }

  // Status of one alert, polled by the page while waiting for Telegram.
  if (path.startsWith("/api/alerts/")) {
    if (!env || !env.WATCH_HUB) return json({ ok: false, error: "Alerts are not configured" }, 503);
    const id = path.slice("/api/alerts/".length).replace(/[^a-z0-9]/g, "");
    return forwardToHub(env, `/watch?id=${id}`);
  }

  // One-off: point the Telegram bot's webhook at this Worker.
  // /api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
  if (path === "/api/telegram/setup") {
    const secret = env && env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      return json({ ok: false, error: "Set TELEGRAM_WEBHOOK_SECRET (16+ letters, digits, _ or -) first" }, 503);
    }
    if (url.searchParams.get("secret") !== secret) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    if (!env.WATCH_HUB) return json({ ok: false, error: "WATCH_HUB binding not configured" }, 503);
    return forwardToHub(env, "/setup", { method: "POST", body: JSON.stringify({ origin: url.origin }) });
  }

  if (path === "/api/health") {
    return json({
      ok: true,
      version: VERSION,
      service: "officeworks-stock-worker",
      currentAvailabilityApi:
        "/catalogue-app/api/availabilities/store/{storeId}/postcode/{postcode}?partNumbers={sku}",
      time: new Date().toISOString()
    });
  }

  if (path === "/api/debug") {
    return json({
      ok: true,
      version: VERSION,
      maxBatchSize: MAX_BATCH_SIZE,
      note:
        "v10 uses Officeworks current catalogue-app availability endpoint from captured HAR.",
      endpoints: OW
    });
  }

  if (path === "/api/stores") {
    const inputState = normaliseState(url.searchParams.get("state") || "all");
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const radiusKm = clampNumber(url.searchParams.get("radiusKm"), 1, 250, 25);
    const origin = originFromParams(url, postcode);
    const resolvedState = origin ? inputState : resolveState(inputState, postcode);

    const result = await getStores({
      state: resolvedState,
      postcode,
      origin,
      radiusKm
    });

    return json({
      ok: true,
      version: VERSION,
      inputState,
      resolvedState,
      postcode,
      radiusKm,
      origin: publicOrigin(origin),
      count: result.stores.length,
      filterMode: result.filterMode,
      stores: result.stores
    });
  }

  // Keyword search for the product picker. Example: /api/search?q=ipad
  if (path === "/api/search") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);

    if (query.length < 2) {
      return json({ ok: false, error: "Query must be at least 2 characters" }, 400);
    }

    const limit = clampInt(url.searchParams.get("limit"), 1, 20, 8);
    const products = await searchProducts(query, limit);

    return json({ ok: true, version: VERSION, query, count: products.length, products });
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

    const result = await getStores({ state: resolvedState });

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
    const postcode = normalisePostcode(url.searchParams.get("postcode"));
    const radiusKm = clampNumber(url.searchParams.get("radiusKm"), 1, 250, 25);
    const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);
    const limit = clampInt(
      url.searchParams.get("limit"),
      1,
      MAX_BATCH_SIZE,
      MAX_BATCH_SIZE
    );
    const origin = originFromParams(url, postcode);
    const resolvedState = origin ? inputState : resolveState(inputState, postcode);

    if (!sku) {
      return json({ ok: false, error: "Missing or invalid sku" }, 400);
    }

    const startedAt = Date.now();

    // product=0 lets the page fetch /api/product separately: Officeworks'
    // product search can take 10+ seconds and should not hold up stock rows.
    const includeProduct = url.searchParams.get("product") !== "0";

    const [product, storeResult] = await Promise.all([
      includeProduct ? getProduct(sku) : null,
      getStores({
        state: resolvedState,
        postcode,
        origin,
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
        inStoreQuantity: 0,
        clickAndCollectQuantity: 0,
        deliveryQuantity: 0,
        status: "no_stock",
        source: "none",
        rawSignal: ""
      };

      let error = "";

      try {
        const lookupPostcode = postcode || store.postcode || "3000";
        const raw = await fetchAvailabilityRaw(store.storeId, lookupPostcode, sku);
        parsed = parseCurrentAvailability(raw, sku);
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
        lat: store.lat,
        lng: store.lng,
        distanceKm: store.distanceKm,
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
        quickCollect: parsed.quickCollect,
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
      origin: publicOrigin(origin),
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

async function handleAppleApi(url, path, env) {
  // Status of the Cloudflare watcher (cron + Durable Object).
  if (path === "/api/apple/watch") {
    if (!env || !env.APPLE_WATCHER) {
      return json({ ok: false, version: VERSION, error: "APPLE_WATCHER binding not configured" }, 503);
    }
    const stub = appleWatcherStub(env);
    // Starts the loop on first visit too, so it runs before the first cron.
    await stub.fetch("https://apple-watcher/ensure");
    const res = await stub.fetch("https://apple-watcher/status");
    return json({ version: VERSION, ...(await res.json()) });
  }

  if (path === "/api/apple/config") {
    return json({
      ok: true,
      version: VERSION,
      cc: "au",
      appleBase: APPLE_BASE,
      stores: APPLE_STORES,
      families: APPLE_FAMILIES
    });
  }

  // Debug: one raw fulfillment-messages call, to see what Apple returns to
  // this Worker. Example: /api/apple/raw?store=R238&parts=MK2E4X/A
  if (path === "/api/apple/raw") {
    const store = normaliseAppleStore(url.searchParams.get("store")) || "R238";
    const parts = parseAppleParts(url.searchParams.get("parts"));
    const startedAt = Date.now();

    try {
      const result = await fetchFulfillment(APPLE_BASE, store, parts.length ? parts : ["MK2E4X/A"]);
      return json({
        ok: true,
        version: VERSION,
        upstreamUrl: result.url,
        durationMs: Date.now() - startedAt,
        parsed: result.parsed,
        raw: result.raw
      });
    } catch (err) {
      return json(
        {
          ok: false,
          version: VERSION,
          blocked: err && err.name === "UpstreamBlockedError",
          upstreamStatus: (err && err.status) || null,
          error: err && err.message ? err.message : "Apple request failed",
          durationMs: Date.now() - startedAt
        },
        502
      );
    }
  }

  // Current pickup availability for one family across the selected stores.
  // Example: /api/apple/check?family=iphoneduo&stores=VIC&caps=256gb
  if (path === "/api/apple/check") {
    const family = String(url.searchParams.get("family") || "iphoneduo").toLowerCase();

    if (!APPLE_FAMILIES[family]) {
      return json({ ok: false, error: `Unknown family. Use one of: ${Object.keys(APPLE_FAMILIES).join(", ")}` }, 400);
    }

    const caps = csvParam(url.searchParams.get("caps"));
    const colors = csvParam(url.searchParams.get("colors"));
    const storeIds = resolveStores(url.searchParams.get("stores"));
    const parts = selectParts(family, { caps, colors });

    if (!parts.length || !storeIds.length) {
      return json({ ok: false, error: "No matching stores or configurations" }, 400);
    }

    // All visitors asking the same question share one upstream scan.
    const cache = caches.default;
    const cacheKey = new Request(
      `https://stock-level-cache.local/apple-check-v1?family=${family}&parts=${parts.join(",")}&stores=${storeIds.join(",")}`
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      return json({ ...payload, cached: true });
    }

    const startedAt = Date.now();
    const scan = await scanStores(APPLE_BASE, parts, {
      anchors: pickAnchors(storeIds),
      targetStores: storeIds
    });

    const rows = storeIds.map((id) => {
      const meta = APPLE_STORE_BY_ID[id];
      const found = scan.stores.get(id);
      const available = found
        ? parts
            .filter((part) => found.parts[part] && found.parts[part].status === "available")
            .map((part) => ({ ...describePart(part), quote: found.parts[part].quote, url: productUrl(part) }))
        : [];

      return {
        storeId: id,
        storeName: meta.name,
        city: meta.city,
        state: meta.state,
        lat: meta.lat,
        lng: meta.lng,
        status: !found ? "unknown" : !found.pickupEligible ? "no_pickup" : available.length ? "in_stock" : "sold_out",
        available
      };
    });

    const payload = {
      ok: !(scan.blocked && scan.stores.size === 0),
      version: VERSION,
      family,
      familyName: APPLE_FAMILIES[family].name,
      parts,
      checkedAt: new Date().toISOString(),
      summary: {
        stores: rows.length,
        storesWithStock: rows.filter((row) => row.status === "in_stock").length,
        requests: scan.requests,
        blocked: scan.blocked,
        durationMs: Date.now() - startedAt
      },
      errors: scan.errors,
      rows
    };

    if (payload.ok) {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(payload), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${APPLE_CHECK_CACHE_SECONDS}`
          }
        })
      );
    }

    return json(payload, payload.ok ? 200 : 502);
  }

  return json({ ok: false, version: VERSION, error: "API route not found", path }, 404);
}

function normaliseAppleStore(value) {
  const id = String(value || "").trim().toUpperCase();
  return /^R\d{3}$/.test(id) ? id : "";
}

function parseAppleParts(value) {
  return csvParam(value)
    .map((part) => part.toUpperCase())
    .filter((part) => /^[A-Z0-9]{5,8}\/A$/.test(part))
    .slice(0, 20);
}

function csvParam(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function getProduct(sku) {
  const cache = caches.default;
  const cacheKey = new Request(`https://stock-level-cache.local/product-v16?sku=${sku}`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  let data = null;

  try {
    data = await fetchJson(OW.productSearch + encodeURIComponent(sku), {
      cacheTtl: 21600,
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

  const directPrice = first && first.price && Number(first.price.single);
  const priceInfo =
    directPrice > 0
      ? { display: formatAudPrice(directPrice), value: directPrice, source: "price.single" }
      : extractPriceInfo(first);

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
    price: priceInfo.display,
    priceValue: priceInfo.value,
    priceSource: priceInfo.source,
    image: officeworksImage(first),
    url: officeworksProductUrl(first),
    brand: String((first && first.attributes && first.attributes.brand) || ""),
    rawFound: Boolean(first)
  };

  const response = new Response(JSON.stringify(product), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=21600"
    }
  });

  // Only cache real hits, so one slow or failed lookup is retried next time.
  if (first) await cache.put(cacheKey, response.clone());
  return product;
}


function extractPriceInfo(product) {
  if (!product || typeof product !== "object") {
    return { display: "", value: null, source: "none" };
  }

  const candidates = [];

  function walk(value, path = "") {
    if (value === null || typeof value === "undefined") return;

    if (typeof value === "number" || typeof value === "string") {
      if (/price|amount|sale|sell|current|was|now|value/i.test(path)) {
        const parsed = parseMoney(value);
        if (parsed !== null && parsed > 0 && parsed < 100000) {
          candidates.push({ value: parsed, source: path });
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        walk(value[key], path ? `${path}.${key}` : key);
      }
    }
  }

  walk(product);

  if (!candidates.length) {
    return { display: "", value: null, source: "not-found" };
  }

  candidates.sort((a, b) => pricePriority(a.source) - pricePriority(b.source));

  const best = candidates[0];

  return {
    display: formatAudPrice(best.value),
    value: best.value,
    source: best.source
  };
}

function pricePriority(source) {
  const s = String(source || "").toLowerCase();

  if (s.includes("current") || s.includes("now") || s.includes("sell") || s.includes("sale")) return 0;
  if (s.includes("price") && !s.includes("was") && !s.includes("save") && !s.includes("rrp")) return 1;
  if (s.includes("amount") || s.includes("value")) return 2;
  if (s.includes("was") || s.includes("rrp") || s.includes("save")) return 9;

  return 5;
}

function parseMoney(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const text = String(value || "").replace(/,/g, "").trim();
  const match = text.match(/(?:A\$|\$)?\s*(\d+(?:\.\d{1,2})?)/i);

  if (!match) return null;

  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function formatAudPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "";

  return `$${n.toFixed(2)}`;
}

async function getStores({ state = "all", postcode = "", origin = null, radiusKm = 25 } = {}) {
  const cache = caches.default;
  const cacheKey = new Request("https://stock-level-cache.local/stores-v11");

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

    const response = new Response(JSON.stringify(stores), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=43200"
      }
    });

    await cache.put(cacheKey, response.clone());
  }

  if (state !== "all") {
    stores = stores.filter((store) => String(store.state || "").toUpperCase() === state);
  }

  // Real distance from the postcode centre or the browser's location.
  if (origin) {
    return {
      stores: storesWithinRadius(stores, origin, radiusKm).map((store) => ({
        ...store,
        distanceSource: origin.source
      })),
      filterMode: "radius"
    };
  }

  if (!postcode) {
    return {
      stores,
      filterMode: state === "all" ? "all-states" : "state-only"
    };
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

function originFromParams(url, postcode) {
  return resolveOrigin({
    lat: url.searchParams.get("lat"),
    lng: url.searchParams.get("lng"),
    postcode
  });
}

// Rounded so responses do not echo a visitor's exact location.
function publicOrigin(origin) {
  if (!origin) return null;
  return {
    source: origin.source,
    postcode: origin.postcode,
    state: origin.state,
    lat: Math.round(origin.lat * 100) / 100,
    lng: Math.round(origin.lng * 100) / 100
  };
}

async function searchProducts(query, limit) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://stock-level-cache.local/search-v1?q=${encodeURIComponent(query.toLowerCase())}&limit=${limit}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const data = await fetchJson(
    OW.productSearch.replace("pageSize=50", `pageSize=${limit}`) + encodeURIComponent(query),
    { cacheTtl: 3600, label: "Officeworks product search" }
  );

  const products = (Array.isArray(data && data.products) ? data.products : [])
    .map((item) => {
      const identity = item.identity || {};
      const price = item.price && Number(item.price.single);
      return {
        sku: String(identity.partNumber || item.partNumber || "").toUpperCase(),
        name: decodeHtml(String(identity.name || item.name || "")),
        price: price > 0 ? formatAudPrice(price) : "",
        image: officeworksImage(item),
        url: officeworksProductUrl(item),
        brand: String((item.attributes && item.attributes.brand) || "")
      };
    })
    .filter((product) => product.sku && product.name)
    .slice(0, limit);

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(products), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600"
      }
    })
  );

  return products;
}

function officeworksImage(product) {
  const description = (product && product.description) || {};
  const src = String(description.thumbnail || description.fullImage || "");
  return src.startsWith("//") ? `https:${src}` : src;
}

function officeworksProductUrl(product) {
  const src = String((product && product.url) || "");
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `https://www.officeworks.com.au${src}`;
  return src;
}

function normaliseStore(store) {
  const addressObj = store && store.address ? store.address : {};
  const contactObj = store && store.contact ? store.contact : {};
  const locationObj = store && store.location ? store.location : {};

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
    phone: String(contactObj.storeTelephone || contactObj.phone || store.phone || ""),
    lat: parseCoord(locationObj.lat ?? locationObj.storeGeocodeLat),
    lng: parseCoord(locationObj.lon ?? locationObj.storeGeocodeLon)
  };
}

function parseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
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

function clampNumber(value, min, max, fallback) {
  const n = Number(String(value ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stockSortValue(row) {
  if (!row) return 0;
  const qty = Number(row.qty || 0);
  return Number.isFinite(qty) ? qty : 0;
}

function sortDistanceValue(row) {
  if (!row) return 999999;
  if (typeof row.distanceKm === "number") return row.distanceKm;
  if (typeof row.postcodeScore === "number") return row.postcodeScore;
  return 999999;
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
