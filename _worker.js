// _worker.js — Scraper coches.net (versión Cloudflare Worker)
// Uso:
//   https://TU_DOMINIO.pages.dev/?pass=cochesnetwp&dealer=eslautoautomocionvn&format=json|csv|jsonl
//   ?download=1   -> fuerza Content-Disposition
//   ?pretty=1     -> JSON indentado

const SECRET = (() => atob("Y29jaGVzbmV0d3A="))(); // cochesnetwp

export default {
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return preflight();

    // pass obligatorio
    const pass = url.searchParams.get("pass") || "";
    if (pass !== SECRET) {
      return cors(json({ error: "UNAUTHORIZED" }, 401));
    }

    const dealer = url.searchParams.get("dealer");
    const directUrl = url.searchParams.get("url");
    const format = (url.searchParams.get("format") || "json").toLowerCase();
    const download = url.searchParams.get("download") === "1";
    const pretty = url.searchParams.get("pretty") === "1";

    const BASE = "https://www.coches.net";
    const target = directUrl
      ? directUrl
      : dealer
      ? `${BASE}/concesionario/${dealer}/`
      : null;

    if (!target) {
      return cors(json({ error: "BAD_REQUEST", message: "Falta dealer o url" }, 400));
    }

    // fetch concesionario
    const r = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!r.ok) {
      return cors(
        json(
          { error: "FETCH_FAILED", status: r.status, message: `Fallo al descargar ${target}` },
          502
        )
      );
    }
    const html = await r.text();

    // __INITIAL_PROPS__
    const data = extractInitialProps(html);
    if (!data) {
      return cors(json({ error: "PARSING_ERROR", message: "__INITIAL_PROPS__ no encontrado" }, 500));
    }

    const { items, totalResults } = extractVehiclesList(data);
    const domIdx = buildDomIndexByLink(html, BASE);
    const flatRows = items.map((it) => flattenItem(it, domIdx, BASE));

    // salida
    let body,
      contentType,
      filename = "coches_concesionario";
    if (format === "jsonl") {
      body = toJSONL(items);
      contentType = "application/x-ndjson; charset=utf-8";
      filename += "_raw.jsonl";
    } else if (format === "csv") {
      body = toCSV(flatRows);
      contentType = "text/csv; charset=utf-8";
      filename += "_flat.csv";
    } else {
      body = JSON.stringify(
        { ok: true, meta: { url: target, totalResults, count: flatRows.length }, items: flatRows },
        null,
        pretty ? 2 : 0
      );
      contentType = "application/json; charset=utf-8";
      filename += "_flat.json";
    }

    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      ...(download ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}),
    };
    return cors(new Response(body, { status: 200, headers }));
  },
};

/* ---------------- Helpers ---------------- */

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function extractInitialProps(html) {
  const re = /__INITIAL_PROPS__\s*=\s*(\{[\s\S]*?\})\s*;?/;
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
function extractVehiclesList(data) {
  const vl = data.vehiclesList || {};
  const items = Array.isArray(vl.items) ? vl.items : [];
  return { items, totalResults: vl.totalResults || items.length };
}

function normalizeUrl(href, base) {
  if (!href) return "";
  if (/^https?:\/\//.test(href)) return href;
  return new URL(href, base).toString();
}

function buildDomIndexByLink(html, base) {
  const idx = {};
  const re = /<a[^>]+href="([^"]+?(?:\.aspx|covo)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hrefAbs = normalizeUrl(m[1], base);
    const slice = html.slice(Math.max(0, m.index - 1200), m.index + 1200);
    const extra = {};

    // garantía / IVA
    const reInfo = /<[^>]*class="[^"]*mt-CardAdPrice-infoItem[^"]*"[^>]*>(.*?)<\/[^>]*>/gi;
    let x;
    while ((x = reInfo.exec(slice)) !== null) {
      const txt = strip(x[1]);
      if (/garant/i.test(txt)) extra.garantia_text = txt;
      if (/iva/i.test(txt)) extra.iva_text = txt;
    }

    // etiqueta ambiental alt
    const reEnv = /<li[^>]*mt-CardAd-attrItemEnvironmentalLabel[^>]*>[\s\S]*?<img[^>]*alt="([^"]+)"/i;
    const e2 = slice.match(reEnv);
    if (e2) extra.etiqueta_ambiental_alt = e2[1];

    // potencia "123 cv"
    const e3 = slice.match(/\b(\d+)\s*cv\b/i);
    if (e3) extra.potencia_cv_dom = parseInt(e3[1], 10);

    if (Object.keys(extra).length) idx[hrefAbs] = extra;
  }
  return idx;
}
function strip(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function flattenItem(it, domIdx, base) {
  const out = {};
  for (const [k, v] of Object.entries(it)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  out.potencia_cv = Number.isInteger(it.hp) ? it.hp : null;
  out.iva_incluido = !!it.includesTaxes;
  out.con_garantia = !!it.hasWarranty;
  out.enlace_abs = normalizeUrl(it.url, base);

  const loc = it.location || {};
  if (typeof loc === "object") {
    out.location_region = loc.regionLiteral;
    out.location_provincia = loc.mainProvince;
    out.location_ciudad = loc.cityLiteral;
    out.location_region_id = loc.regionId;
    out.location_provincia_id = loc.mainProvinceId;
    if (Array.isArray(loc.provinceIds)) {
      out.location_provinceIds = loc.provinceIds.join(",");
    }
  }
  const sel = it.seller || {};
  for (const [k, v] of Object.entries(sel)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out["seller_" + k] = v;
    }
  }
  const pack = it.pack || {};
  for (const [k, v] of Object.entries(pack)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out["pack_" + k] = v;
    }
  }

  out.fotos_count = Array.isArray(it.photos) ? it.photos.length : null;
  out.videos_count = Array.isArray(it.videos) ? it.videos.length : null;

  const dx = domIdx[out.enlace_abs] || {};
  if (dx.garantia_text) out.garantia_text = dx.garantia_text;
  if (dx.iva_text) out.iva_text = dx.iva_text;
  if (dx.etiqueta_ambiental_alt) out.etiqueta_ambiental_alt = dx.etiqueta_ambiental_alt;
  if (!out.potencia_cv && dx.potencia_cv_dom) out.potencia_cv = dx.potencia_cv_dom;

  out.environmentalLabel_json = it.environmentalLabel;
  return out;
}

function toJSONL(items) {
  return items.map((it) => JSON.stringify(it)).join("\n");
}
function toCSV(rows) {
  if (!rows.length) return "";
  const cols = Array.from(rows.reduce((s, r) => { for (const k of Object.keys(r)) s.add(k); return s; }, new Set()));
  const esc = (v) => (v == null ? "" : typeof v === "number" || typeof v === "boolean" ? String(v) : `"${String(v).replace(/"/g,'""')}"`);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
