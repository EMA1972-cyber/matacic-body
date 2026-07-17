// ============================================================
//  withings-sync
//  ------------------------------------------------------------
//  Holt Messungen von Withings und legt sie in "measurements" ab.
//
//  Aufruf:
//    ?key=<SYNC_KEY>              -> letzte 14 Tage
//    ?key=<SYNC_KEY>&from=2026-05-18  -> ab Datum
//    ?key=<SYNC_KEY>&all=1        -> komplette Historie
//
//  Verify JWT muss AUS sein (Schutz laeuft ueber SYNC_KEY).
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const WITHINGS_TOKEN = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_MEASURE = "https://wbsapi.withings.net/measure";
const TZ = "Europe/Berlin";

// Alles, was wir bei Withings anfragen.
// Die bekannten mappen wir auf Spalten, der Rest landet in "extra".
const MEASTYPES = [1, 5, 6, 8, 76, 77, 88, 91, 123, 155, 168, 169, 170, 174, 175, 226];

const TYPE_TO_COLUMN: Record<number, string> = {
  1: "weight_kg",
  5: "lean_mass_kg",
  6: "fat_ratio",
  8: "fat_mass_kg",
  76: "muscle_mass_kg",
  77: "hydration_kg",
  88: "bone_mass_kg",
  91: "pwv",
};

// Namen fuer alles, was (noch) keine eigene Spalte hat
const TYPE_LABELS: Record<number, string> = {
  123: "vo2_max",
  155: "vascular_age",
  168: "extracellular_water",
  169: "intracellular_water",
  170: "visceral_fat",
  174: "fat_mass_segments",
  175: "muscle_mass_segments",
  226: "basal_metabolic_rate",
};

// ------------------------------------------------------------
function resolveServiceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy && legacy.length > 0) return legacy;

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) throw new Error("Kein Service-Key gefunden.");

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") return entry;
        const v = entry?.api_key ?? entry?.key ?? entry?.secret ?? entry?.value;
        if (typeof v === "string") return v;
      }
    }

    if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed)) {
        if (typeof v === "string" && v.length > 0) return v;
        const nested = (v as Record<string, unknown>)?.api_key
          ?? (v as Record<string, unknown>)?.key
          ?? (v as Record<string, unknown>)?.value;
        if (typeof nested === "string") return nested;
      }
    }
  } catch (_e) {
    if (raw.startsWith("sb_secret_") || raw.startsWith("ey")) return raw;
  }
  throw new Error("Service-Key nicht lesbar.");
}

// Unix-Sekunden -> "YYYY-MM-DD" in deutscher Zeitzone
function toLocalDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000)
    .toLocaleDateString("sv-SE", { timeZone: TZ });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ------------------------------------------------------------
//  Gueltigen Access-Token besorgen (ggf. erneuern)
// ------------------------------------------------------------
async function getValidToken(supabase: ReturnType<typeof createClient>) {
  const { data: row, error } = await supabase
    .from("withings_tokens")
    .select("*")
    .eq("id", 1)
    .single();

  if (error || !row) {
    throw new Error("Keine Withings-Tokens gefunden. Bitte zuerst withings-callback aufrufen.");
  }

  // Noch 5 Minuten Puffer, dann lieber erneuern
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 5 * 60 * 1000) {
    return row.access_token as string;
  }

  console.log("Access-Token abgelaufen -> erneuere");

  const form = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: Deno.env.get("WITHINGS_CLIENT_ID")!,
    client_secret: Deno.env.get("WITHINGS_CLIENT_SECRET")!,
    refresh_token: row.refresh_token as string,
  });

  const res = await fetch(WITHINGS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = await res.json();
  if (data.status !== 0) {
    throw new Error(`Token-Refresh fehlgeschlagen (status ${data.status}). ` +
      `Ggf. withings-callback erneut aufrufen.`);
  }

  const b = data.body;
  const newExpiry = new Date(Date.now() + (b.expires_in ?? 10800) * 1000);

  // WICHTIG: Withings rotiert den refresh_token -- beide speichern!
  await supabase.from("withings_tokens").upsert({
    id: 1,
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: newExpiry.toISOString(),
    updated_at: new Date().toISOString(),
  });

  return b.access_token as string;
}

// ------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);

    // --- Zugriffsschutz ---
    const syncKey = Deno.env.get("SYNC_KEY");
    if (!syncKey) {
      return json({ error: "SYNC_KEY ist nicht gesetzt. Bitte in den Edge Function Secrets anlegen." }, 500);
    }
    const provided = url.searchParams.get("key") ?? req.headers.get("x-sync-key");
    if (provided !== syncKey) {
      return json({ error: "Nicht autorisiert." }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      resolveServiceKey(),
      { auth: { persistSession: false } },
    );

    const accessToken = await getValidToken(supabase);

    // --- Zeitraum bestimmen ---
    const now = Math.floor(Date.now() / 1000);
    let startdate: number;

    if (url.searchParams.get("all") === "1") {
      startdate = Math.floor(new Date("2015-01-01T00:00:00Z").getTime() / 1000);
    } else if (url.searchParams.get("from")) {
      startdate = Math.floor(new Date(url.searchParams.get("from") + "T00:00:00Z").getTime() / 1000);
    } else {
      startdate = now - 14 * 24 * 3600;
    }

    // --- Messungen holen ---
    const form = new URLSearchParams({
      action: "getmeas",
      meastypes: MEASTYPES.join(","),
      category: "1",
      startdate: String(startdate),
      enddate: String(now),
    });

    const res = await fetch(WITHINGS_MEASURE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const data = await res.json();
    if (data.status !== 0) {
      console.error("Withings getmeas Fehler:", JSON.stringify(data));
      return json({ error: `Withings status ${data.status}`, detail: data }, 502);
    }

    const groups = data.body?.measuregrps ?? [];

    // --- Nach Tag buendeln ---
    // WICHTIG: Withings zerlegt eine Wiege-Session teils in MEHRERE
    // Messgruppen (z.B. Gewicht/Fett um 06:55:00, PWG um 06:55:30).
    // Wir mergen deshalb ALLE Gruppen eines Tages feldweise, statt
    // nur die spaeteste zu nehmen -- sonst gehen Werte verloren.
    const byDate = new Map<string, Record<string, unknown>>();
    const unknownTypes = new Set<number>();

    // aufsteigend sortieren -> spaetere Werte ueberschreiben fruehere
    const sorted = [...groups].sort((a, b) => a.date - b.date);

    for (const grp of sorted) {
      const day = toLocalDate(grp.date);

      let row = byDate.get(day);
      if (!row) {
        row = {
          measured_on: day,
          measured_at: new Date(grp.date * 1000).toISOString(),
          source: "withings",
          updated_at: new Date().toISOString(),
          extra: {} as Record<string, number>,
        };
        byDate.set(day, row);
      }

      let hasWeight = false;

      for (const m of grp.measures ?? []) {
        const value = m.value * Math.pow(10, m.unit);
        const col = TYPE_TO_COLUMN[m.type];

        if (m.type === 1) hasWeight = true;

        if (col) {
          row[col] = Number(value.toFixed(2));
        } else {
          const label = TYPE_LABELS[m.type] ?? `type_${m.type}`;
          (row.extra as Record<string, number>)[label] = Number(value.toFixed(2));
          if (!TYPE_LABELS[m.type]) unknownTypes.add(m.type);
        }
      }

      // Zeitstempel der Waage-Messung ist aussagekraeftiger als der
      // einer Nachzuegler-Gruppe (z.B. nur PWG)
      if (hasWeight) {
        row.measured_at = new Date(grp.date * 1000).toISOString();
      }
    }

    // Leeres extra -> null (statt {})
    const rows = [...byDate.values()].map((r) => {
      const extra = r.extra as Record<string, number>;
      return { ...r, extra: Object.keys(extra).length ? extra : null };
    });

    if (rows.length === 0) {
      return json({
        ok: true,
        message: "Keine Messungen im Zeitraum gefunden.",
        von: toLocalDate(startdate),
        bis: toLocalDate(now),
      });
    }

    const { error: dbError } = await supabase
      .from("measurements")
      .upsert(rows, { onConflict: "measured_on" });

    if (dbError) {
      console.error("DB-Fehler:", dbError);
      return json({ error: dbError.message }, 500);
    }

    return json({
      ok: true,
      gespeichert: rows.length,
      davon_mit_gewicht: rows.filter((r) => r.weight_kg != null).length,
      von: toLocalDate(startdate),
      bis: toLocalDate(now),
      messgruppen_gesamt: groups.length,
      // Damit wir sehen, was deine Waage sonst noch schickt:
      unbekannte_typen: [...unknownTypes],
      juengste: rows[rows.length - 1],
    });

  } catch (e) {
    console.error("Fehler:", e);
    return json({ error: String(e) }, 500);
  }
});
