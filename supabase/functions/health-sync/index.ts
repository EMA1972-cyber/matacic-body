import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Health Auto Export (Apple Health) -> nutrition
// Aktivitaet: steps_apple, kcal_apple
// Ernaehrung (Fddb schreibt nach Apple Health): kcal_in, protein_g, carbs_g, fat_g, drinks_ml
//
// v7 (28.07.2026)
//  - loggt jeden eingehenden Payload nach public.health_raw
//  - Wasser wird NUR noch aus der Automation mit ?src=raw uebernommen
//    (dort liefert HAE Einzelmessungen statt einer Tagessumme)
//  - Entdopplung: Fddb schreibt beim Korrigieren des Wasserzaehlers den
//    neuen Stand nach Apple Health, ohne den alten zu loeschen. Beide
//    Messungen tragen dieselbe Minute. Regel: liegen in derselben Minute
//    mehrere Messungen >= DEDUP_MIN_ML, zaehlt nur die groesste.
//    Kleine Werte (Getraenke aus dem Tagebuch, Wasseranteil fester
//    Lebensmittel) werden immer voll addiert.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_KEY     = Deno.env.get("SYNC_KEY")!;

const DEDUP_MIN_ML = 1000;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function dayOf(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// "2026-07-17 21:45:00 +0200" -> "2026-07-17 21:45"
function minuteOf(raw: string): string {
  if (typeof raw !== "string") return "";
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/);
  return m ? m[1] : raw;
}

async function logRaw(src: string, metrics: string[], payload: unknown) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/health_raw`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ src, metrics, payload }),
    });
  } catch (_e) {
    // Logging darf den Sync niemals scheitern lassen
  }
}

// Summiert Wassermessungen eines Tages und entfernt dabei verwaiste
// Zaehlerstaende, die in derselben Minute doppelt geschrieben wurden.
function waterTotal(samples: { qty: number; min: string }[]): number {
  const byMinute: Record<string, number[]> = {};
  let small = 0;
  for (const s of samples) {
    if (s.qty < DEDUP_MIN_ML) { small += s.qty; continue; }
    (byMinute[s.min] ??= []).push(s.qty);
  }
  let big = 0;
  for (const vals of Object.values(byMinute)) big += Math.max(...vals);
  return small + big;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== SYNC_KEY) return json({ ok: false, error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const isRaw = url.searchParams.get("src") === "raw";

  let payload: any;
  try { payload = await req.json(); } catch (_e) { return json({ ok: false, error: "invalid json" }, 400); }

  const metrics = payload?.data?.metrics;
  if (!Array.isArray(metrics)) return json({ ok: false, error: "data.metrics missing" }, 400);

  const days: Record<string, Record<string, number>> = {};
  const seen: string[] = [];
  const water: Record<string, { qty: number; min: string }[]> = {};
  const add = (day: string, col: string, val: number) => {
    (days[day] ??= {})[col] = (days[day][col] ?? 0) + val;
  };

  for (const metric of metrics) {
    const name  = String(metric?.name ?? "").toLowerCase();
    const units = String(metric?.units ?? "").toLowerCase();
    const rows  = Array.isArray(metric?.data) ? metric.data : [];
    if (!rows.length) continue;
    seen.push(name);

    let col: string | null = null;
    let factor = 1;

    if (name.includes("step") && !name.includes("cadence")) {
      col = "steps_apple";
    } else if (name.includes("active_energy")) {
      col = "kcal_apple";
      if (units.includes("kj")) factor = 1 / 4.184;
    } else if (name.includes("dietary_energy")) {
      col = "kcal_in";
      if (units.includes("kj")) factor = 1 / 4.184;
    } else if (name.includes("protein")) {
      col = "protein_g";
    } else if (name.includes("carbohydrate")) {
      col = "carbs_g";
    } else if (name.includes("total_fat") || name === "fat") {
      col = "fat_g";
    } else if (name.includes("dietary_water") || name === "water") {
      col = "drinks_ml";
      if (/\bl\b/.test(units) && !units.includes("ml")) factor = 1000;
    }
    if (!col) continue;

    // Wasser aus der aggregierten Automation ignorieren — sonst wuerden sich
    // beide Automationen stuendlich gegenseitig ueberschreiben.
    if (col === "drinks_ml" && !isRaw) continue;

    for (const row of rows) {
      const day = dayOf(row?.date);
      const qty = Number(row?.qty);
      if (!day || !isFinite(qty)) continue;
      if (col === "drinks_ml") {
        (water[day] ??= []).push({ qty: qty * factor, min: minuteOf(row.date) });
      } else {
        add(day, col, qty * factor);
      }
    }
  }

  for (const [day, samples] of Object.entries(water)) {
    add(day, "drinks_ml", waterTotal(samples));
  }

  // Roh-Payload protokollieren (nach dem Parsen, damit "seen" mitgeht)
  await logRaw(isRaw ? "raw" : "agg", seen, payload);

  const intCols = new Set(["steps_apple", "kcal_apple", "kcal_in", "drinks_ml"]);
  const allRows = Object.entries(days).map(([day, cols]) => {
    const r: Record<string, unknown> = { day };
    for (const [c, v] of Object.entries(cols)) {
      r[c] = intCols.has(c) ? Math.round(v) : Math.round(v * 10) / 10;
    }
    return r;
  }).filter((r) => Object.keys(r).length > 1);

  if (!allRows.length) return json({ ok: true, written: 0, metrics: seen, src: isRaw ? "raw" : "agg" });

  // PostgREST verlangt identische Feldmengen je Sammel-Anfrage -> nach Signatur gruppieren
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const r of allRows) {
    const sig = Object.keys(r).sort().join(",");
    (groups[sig] ??= []).push(r);
  }

  const errors: string[] = [];
  for (const batch of Object.values(groups)) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/nutrition?on_conflict=day`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) errors.push(await res.text());
  }

  if (errors.length) return json({ ok: false, errors, metrics: seen }, 500);

  return json({
    ok: true,
    src: isRaw ? "raw" : "agg",
    written: allRows.length,
    metrics: seen,
    days: allRows.map((r) => r.day).sort(),
  });
});
