/**
 * worker.js — Scraper para Cloudflare Workers / Pages
 *
 * Uso:
 *  - ?pass=... (obligatorio)
 *  - ?dealer=<slug>  o  ?url=<concesionario_url>
 *  - ?format=json|jsonl|csv
 *  - ?download=1  (para forzar Content-Disposition)
 *
 * Responde con CORS habilitado.
 */

const SECRET = (() => {
  // hidden
  return typeof atob === "function"
    ? atob("Y29jaGVzbmV0d3A=")
    : Buffer.from("Y29jaGVzbmV0d3A=", "base64").toString("utf8");
})();

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return preflight();
      }

      const pass = url.searchParams.get("pass") || "";
      if (pass !== SECRET) {
        return cors(
          jsonResponse(
            { error: "UNAUTHORIZED", message: "Parámetro 'pass' inválido." },
            401
          )
        );
      }

      const dealer = url.searchParams.get("dealer");
      const directUrl = url.searchParams.get("url");
      const format = (url.searchParams.get("format") || "json").toLowerCase();
      const download = url.searchParams.get("download") === "1";
      const pretty = url.searchParams.get("pretty") === "1";

      const BASE = "https://www.coches.net";
      const target = buildConcesionarioURL({ dealer, url: directUrl, base: BASE });
      if (!target) {
        return cors(
          jsonResponse(
            {
              error: "BAD_REQUEST",
              message:
                "Indica ?dealer=<slug> (p.ej., eslautoautomocionvn) o ?url=https://www.coches.net/concesionario/...",
            },
            400
          )
        );
      }

      const resp = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; CFWorker/1.0; +https://developers.cloudflare.com/workers/)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9",
        },
        cf: { cacheTtl: 90, cacheEverything: false },
      });

      if (!resp.ok) {
        return cors(
          jsonResponse(
            {
              error: "FETCH_FAILED",
              status: resp.status,
              message: `Fallo al descargar ${target}`,
            },
            502
          )
        );
      }

      const html = await resp.text();
      const data = extractInitialProps(html);
      if (!data) {
        return cors(
          jsonResponse(
            {
              error: "PARSING_ERROR",
              message: "__INITIAL_PROPS__ no encontrado. Estructura inesperada.",
            },
            500
          )
        );
      }

      const { items, totalResults } = extractVehiclesList(data);
      const domIdx = buildDomIndexByLink(html, BASE);
      const flatRows = items.map((it) => flattenItem(it, domIdx, BASE));

      let body, contentType, filenameBase = "coches_concesionario";
      if (format === "jsonl") {
        body = toJSONL(items);
        contentType = "application/x-ndjson; charset=utf-8";
        filenameBase += "_raw.jsonl";
      } else if (format === "csv") {
        body = toCSV(flatRows);
        contentType = "text/csv; charset=utf-8";
        filenameBase += "_flat.csv";
      } else {
        body = JSON.stringify(
          {
            ok: true,
            meta: {
              url: target,
              totalResults,
              count: flatRows.length,
              generatedAt: new Date().toISOString(),
            },
            items: flatRows,
          },
          null,
          pretty ? 2 : 0
        );
        contentType = "application/json; charset=utf-8";
        filenameBase += "_flat.json";
      }

      const headers = {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        ...(download ? { "Content-Disposition": `attachment; filename="${filenameBase}"` } : {}),
      };

      return cors(new Response(body, { status: 200, headers }));
    } catch (err) {
      return cors(
        jsonResponse(
          {
            error: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
          500
        )
      );
    }
  },
};

// ---------- Helpers ----------

function preflight() {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  return new Response(null, { status: 204, headers });
}

function cors(resp) {
  // resp puede ser Response o objeto creado por jsonResponse
  if (resp instanceof Response) {
    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return new Response(resp.body, { status: resp.status, headers });
  } else {
    const r = jsonResponse(resp);
    const headers = new Headers(r.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return new Response(r.body, { status: r.status, headers });
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function buildConcesionarioURL({ dealer, url, base }) {
  if (url) {
    try {
      const u = new URL(url);
      return u.toString();
    } catch {
      return null;
    }
  }
  if (!dealer) return null;
  return `${base.replace(/\/+$/, "")}/concesionario/${dealer}/`;
}

function extractInitialProps(html) {
  const re = /__INITIAL_PROPS__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:<\/script>|<)/i;
  const m = html.match(re);
  if (!m) return null;
  let raw = m[1];
  raw = raw.replace(/\/\/[^\n]*\n/g, "\n");
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  raw = raw.replace(/,\s*(\}|\])/g, "$1");
  try {
    return JSON.parse(raw);
  } catch {
    const un = htmlDecode(raw);
    try {
      return JSON.parse(un);
    } catch {
      return null;
    }
  }
}

function extractVehiclesList(data) {
  const vl = (data && data.vehiclesList) || {};
  const items = Array.isArray(vl.items) ? vl.items : Array.isArray(vl) ? vl : [];
  const totalResults = typeof vl.totalResults === "number" ? vl.totalResults : items.length;
  return { items, totalResults };
}

function htmlDecode(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeUrl(href, base) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return "https:" + href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function buildDomIndexByLink(html, base) {
  const idx = Object.create(null);
  const reLink = /<a\b[^>]*href="([^"]+?(?:\.aspx|covo)[^"]*)"/gi;
  let m;
  const matches = [];
  while ((m = reLink.exec(html)) !== null) {
    matches.push({ href: m[1], index: m.index });
  }
  const WIN = 1800;
  for (const it of matches) {
    const hrefAbs = normalizeUrl(it.href, base);
    const start = Math.max(0, it.index - WIN);
    const end = Math.min(html.length, it.index + WIN);
    const slice = html.slice(start, end);
    const extra = {};
    const reInfo = /<[^>]*class="[^"]*mt-CardAdPrice-infoItem[^"]*"[^>]*>([\s\S]*?)<\/[^>]*>/gi;
    let im;
    while ((im = reInfo.exec(slice)) !== null) {
      const txt = stripTags(im[1]).replace(/\s+/g, " ").trim();
      if (!txt) continue;
      const low = txt.toLowerCase();
      if (low.includes("garant") && !extra.garantia_text) extra.garantia_text = txt;
      if (low.includes("iva") && !extra.iva_text) extra.iva_text = txt;
    }
    const reEnvAlt = /<li[^>]*class="[^"]*mt-CardAd-attrItemEnvironmentalLabel[^"]*"[^>]*>[\s\S]*?<img[^>]*alt="([^"]+)"[^>]*>/i;
    const envM = slice.match(reEnvAlt);
    if (envM) extra.etiqueta_ambiental_alt = envM[1].trim();
    const cv = slice.match(/\b(\d+)\s*cv\b/i);
    if (cv) extra.potencia_cv_dom = parseInt(cv[1], 10);
    if (
      extra.garantia_text ||
      extra.iva_text ||
      extra.etiqueta_ambiental_alt ||
      typeof extra.potencia_cv_dom === "number"
    ) {
      idx[hrefAbs] = extra;
    }
  }
  return idx;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

function flattenItem(it, domIdx, base) {
  const out = {};
  for (const [k, v] of Object.entries(it || {})) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  out.potencia_cv = Number.isInteger(it.hp) ? it.hp : null;
  out.iva_incluido = Boolean(it.includesTaxes);
  out.con_garantia = Boolean(it.hasWarranty);
  out.enlace_abs = normalizeUrl(it.url, base);
  const loc = (it && it.location) || {};
  if (loc && typeof loc === "object") {
    out.location_region = loc.regionLiteral ?? null;
    out.location_provincia = loc.mainProvince ?? null;
    out.location_ciudad = loc.cityLiteral ?? null;
    out.location_region_id = loc.regionId ?? null;
    out.location_provincia_id = loc.mainProvinceId ?? null;
    if (Array.isArray(loc.provinceIds)) {
      out.location_provinceIds = loc.provinceIds.join(",");
    }
  }
  const sel = (it && it.seller) || {};
  if (sel && typeof sel === "object") {
    for (const [k, v] of Object.entries(sel)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[`seller_${k}`] = v;
      }
    }
  }
  const pack = (it && it.pack) || {};
  if (pack && typeof pack === "object") {
    for (const [k, v] of Object.entries(pack)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[`pack_${k}`] = v;
      }
    }
  }
  const photos = it.photos;
  out.fotos_count = Array.isArray(photos) ? photos.length : null;
  const vids = it.videos;
  out.videos_count = Array.isArray(vids) ? vids.length : null;
  const dx = domIdx[out.enlace_abs] || {};
  if (dx) {
    if (!out.garantia_text && dx.garantia_text) out.garantia_text = dx.garantia_text;
    if (!out.iva_text && dx.iva_text) out.iva_text = dx.iva_text;
    if (!out.etiqueta_ambiental_alt && dx.etiqueta_ambiental_alt) out.etiqueta_ambiental_alt = dx.etiqueta_ambiental_alt;
    if ((out.potencia_cv === null || out.potencia_cv === undefined) && typeof dx.potencia_cv_dom === "number") {
      out.potencia_cv = dx.potencia_cv_dom;
    }
  }
  out.environmentalLabel_json = it.environmentalLabel ?? null;
  return out;
}

function toJSONL(items) {
  return items.map((it) => JSON.stringify(it, null, 0)).join("\n") + "\n";
}

function toCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols = unionColumns(rows);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const header = cols.map((c) => `"${c}"`).join(",");
  const lines = rows.map((r) => cols.map((c) => escape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

function unionColumns(rows) {
  const set = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) set.add(k);
  }
  const preferred = [
    "title","make","model","year","km","price","includesTaxes","iva_incluido","iva_text",
    "hasWarranty","garantia_text","warrantyId","warrantyMonths",
    "hp","potencia_cv","fuelType","environmentalLabel_json","etiqueta_ambiental_alt",
    "bodyTypeId","offerType","isProfessional","isFinanced","isCertified",
    "location_region","location_provincia","location_ciudad","location_region_id","location_provincia_id","location_provinceIds",
    "id","url","enlace_abs","img","imgUrl","photos","fotos_count","videos","videos_count",
    "makeId","modelId","specificFuelTypeId","taxTypeId","priceAverageIndicator","priceRankIndicator",
    "creationDate","publicationDate","isUrlSemantic","hasOnlineFinancing","hasReservation",
    "seller_id","seller_type","seller_name","seller_phone","seller_email","pack_type","pack_legacyId"
  ];
  const cols = [];
  for (const p of preferred) {
    if (set.has(p)) {
      cols.push(p);
      set.delete(p);
    }
  }
  for (const k of set) cols.push(k);
  return cols;
}
