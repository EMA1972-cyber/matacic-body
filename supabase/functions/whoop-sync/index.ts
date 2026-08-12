// whoop-sync — holt Recovery / Sleep / Cycles von der Whoop API v2
// Aufruf: ?key=SYNC_KEY [&days=N]   (N Standard 7, max 25)
//
// WICHTIG: Whoop rotiert Refresh-Tokens. Jeder Tausch invalidiert den alten.
// Der neue Token wird daher IMMER geschrieben, BEVOR die Abfragen starten.

const WHOOP_HOST = 'https://api.prod.whoop.com';
const TOKEN_URL  = WHOOP_HOST + '/oauth/oauth2/token';
const API        = WHOOP_HOST + '/developer/v2';
const TZ         = 'Europe/Berlin';

const CLIENT_ID     = Deno.env.get('WHOOP_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('WHOOP_CLIENT_SECRET') || '';
const SYNC_KEY      = Deno.env.get('SYNC_KEY') || '';
const SB_URL        = Deno.env.get('SUPABASE_URL') || '';
const SB_KEY        = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const SB_HEAD = {
  apikey: SB_KEY,
  authorization: 'Bearer ' + SB_KEY,
  'content-type': 'application/json',
};

function jsonOut(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Datum in lokaler Zeit (Europe/Berlin) als YYYY-MM-DD
function berlinDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return p; // en-CA liefert bereits YYYY-MM-DD
}

function hours(milli: number | null | undefined): number | null {
  if (milli === null || milli === undefined) return null;
  return Math.round((milli / 3600000) * 100) / 100;
}

function round(v: number | null | undefined, n = 2): number | null {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

async function logRaw(endpoint: string, payload: unknown) {
  try {
    await fetch(SB_URL + '/rest/v1/whoop_raw', {
      method: 'POST',
      headers: Object.assign({}, SB_HEAD, { prefer: 'return=minimal' }),
      body: JSON.stringify([{ endpoint: endpoint, payload: payload }]),
    });
  } catch (_e) { /* Log-Fehler duerfen den Sync nicht stoppen */ }
}

// --- Token holen / erneuern -------------------------------------------------
async function getAccessToken(notes: string[]): Promise<string> {
  const r = await fetch(SB_URL + '/rest/v1/whoop_tokens?id=eq.1&select=*', { headers: SB_HEAD });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Keine Tokens in whoop_tokens. Erst whoop-callback aufrufen.');
  }
  const t = rows[0];
  const expMs = t.expires_at ? new Date(t.expires_at).getTime() : 0;

  // 2 Minuten Puffer
  if (expMs > Date.now() + 120000 && t.access_token) {
    notes.push('Access-Token noch gueltig');
    return t.access_token;
  }

  if (!t.refresh_token) throw new Error('Kein Refresh-Token gespeichert.');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'offline',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Token-Refresh fehlgeschlagen (HTTP ' + res.status + '): ' + txt.slice(0, 200));

  const tok = JSON.parse(txt);

  // ZUERST speichern, DANN weiterarbeiten — sonst Aussperrung bei Abbruch
  const save = await fetch(SB_URL + '/rest/v1/whoop_tokens?on_conflict=id', {
    method: 'POST',
    headers: Object.assign({}, SB_HEAD, { prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{
      id: 1,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || t.refresh_token,
      expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!save.ok) throw new Error('Neuer Token konnte NICHT gespeichert werden — Abbruch vor Abfrage.');

  notes.push('Token erneuert' + (tok.refresh_token ? ' (Refresh-Token rotiert)' : ''));
  return tok.access_token;
}

async function whoopGet(path: string, token: string, params: Record<string, string>) {
  const u = new URL(API + path);
  for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
  const res = await fetch(u.toString(), { headers: { authorization: 'Bearer ' + token } });
  const txt = await res.text();
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ': ' + txt.slice(0, 200));
  const data = JSON.parse(txt);
  await logRaw(path, data);
  return data;
}

// PostgREST verlangt bei Sammel-Upserts identische Feldmengen je Zeile.
// Darum nach Feld-Signatur gruppieren und in mehreren Requests schreiben.
async function upsertDaily(rows: Record<string, any>[]): Promise<number> {
  const groups: Record<string, Record<string, any>[]> = {};
  for (const row of rows) {
    const clean: Record<string, any> = {};
    for (const k of Object.keys(row)) {
      if (row[k] !== null && row[k] !== undefined) clean[k] = row[k];
    }
    const sig = Object.keys(clean).sort().join(',');
    if (!groups[sig]) groups[sig] = [];
    groups[sig].push(clean);
  }
  let n = 0;
  for (const sig of Object.keys(groups)) {
    const res = await fetch(SB_URL + '/rest/v1/whoop_daily?on_conflict=day', {
      method: 'POST',
      headers: Object.assign({}, SB_HEAD, { prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(groups[sig]),
    });
    if (!res.ok) throw new Error('Upsert fehlgeschlagen: ' + (await res.text()).slice(0, 300));
    n += groups[sig].length;
  }
  return n;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== SYNC_KEY || !SYNC_KEY) {
    return jsonOut({ error: 'unauthorized' }, 401);
  }

  const notes: string[] = [];
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 25);

  try {
    const token = await getAccessToken(notes);

    const end   = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const range = { start: start.toISOString(), end: end.toISOString(), limit: '25' };

    // pro Tag ein Objekt, wird aus drei Quellen gefuellt
    const byDay: Record<string, Record<string, any>> = {};
    const put = (day: string | null, patch: Record<string, any>) => {
      if (!day) return;
      if (!byDay[day]) byDay[day] = { day: day };
      Object.assign(byDay[day], patch);
    };

    // --- Sleep: Tag = Datum des Aufwachens (end) --------------------------
    const sleepDayById: Record<string, string> = {};
    const sleep = await whoopGet('/activity/sleep', token, range);
    for (const rec of (sleep.records || [])) {
      if (rec.nap) continue;                      // Nickerchen nicht als Nacht werten
      const day = berlinDay(rec.end);
      if (!day) continue;
      sleepDayById[String(rec.id)] = day;
      const s = rec.score || {};
      const ss = s.stage_summary || {};
      const light = ss.total_light_sleep_time_milli;
      const deep  = ss.total_slow_wave_sleep_time_milli;
      const rem   = ss.total_rem_sleep_time_milli;
      const total = (light || 0) + (deep || 0) + (rem || 0);
      put(day, {
        sleep_id: String(rec.id),
        sleep_total_h: total > 0 ? hours(total) : null,
        sleep_deep_h: hours(deep),
        sleep_rem_h: hours(rem),
        sleep_light_h: hours(light),
        sleep_awake_h: hours(ss.total_awake_time_milli),
        sleep_performance_pct: round(s.sleep_performance_percentage, 1),
        sleep_efficiency_pct: round(s.sleep_efficiency_percentage, 1),
        respiratory_rate: round(s.respiratory_rate, 2),
      });
    }
    notes.push('Sleep: ' + (sleep.records || []).length + ' Datensaetze');

    // --- Recovery: haengt am Schlaf, daher ueber sleep_id zuordnen --------
    const rec_ = await whoopGet('/recovery', token, range);
    for (const rec of (rec_.records || [])) {
      const day = sleepDayById[String(rec.sleep_id)] || berlinDay(rec.created_at);
      const s = rec.score || {};
      put(day, {
        recovery_score: round(s.recovery_score, 0),
        hrv_rmssd: round(s.hrv_rmssd_milli, 2),
        resting_hr: round(s.resting_heart_rate, 0),
        spo2_pct: round(s.spo2_percentage, 1),
        skin_temp_c: round(s.skin_temp_celsius, 1),
      });
    }
    notes.push('Recovery: ' + (rec_.records || []).length + ' Datensaetze');

    // --- Cycles: Tag = Ende des Zyklus (laufender Zyklus = heute) ---------
    const cyc = await whoopGet('/cycle', token, range);
    for (const rec of (cyc.records || [])) {
      const day = berlinDay(rec.end || new Date().toISOString());
      const s = rec.score || {};
      put(day, {
        cycle_id: String(rec.id),
        day_strain: round(s.strain, 2),
        avg_hr: round(s.average_heart_rate, 0),
        max_hr: round(s.max_heart_rate, 0),
        // Kilojoule = GESAMTumsatz des Tages, nicht nur Aktivkalorien
        kcal_out_whoop: s.kilojoule ? round(s.kilojoule / 4.184, 0) : null,
      });
    }
    notes.push('Cycles: ' + (cyc.records || []).length + ' Datensaetze');

    // --- Body Measurement: Whoops Rechengrundlage -------------------------
    // Aendert sich NUR durch manuelles Nachziehen im Whoop-Profil. Der
    // Apple-Health-Import fuettert die Trendanzeige, NICHT diese Werte.
    // Deshalb pro Tag mitschreiben — so wird sichtbar, ab wann die
    // Kalorienrechnung auf einem veralteten Gewicht steht.
    try {
      const bm = await whoopGet('/user/measurement/body', token, {});
      put(berlinDay(new Date().toISOString()), {
        profile_weight_kg: round(bm.weight_kilogram, 1),
        profile_height_m:  round(bm.height_meter, 2),
        profile_max_hr:    round(bm.max_heart_rate, 0),
      });
      notes.push('Profil: ' + bm.weight_kilogram + ' kg · max ' + bm.max_heart_rate + ' bpm');
    } catch (e) {
      // Darf den Sync nicht kippen — die Tageswerte sind wichtiger.
      notes.push('Body-Measurement nicht abrufbar: ' + String(e));
    }

    const rows = Object.keys(byDay).sort().map((d) => {
      byDay[d].updated_at = new Date().toISOString();
      return byDay[d];
    });

    const written = rows.length ? await upsertDaily(rows) : 0;

    return jsonOut({
      ok: true,
      zeitraum_tage: days,
      tage_geschrieben: written,
      tage: rows.map((r) => r.day),
      hinweise: notes,
    });
  } catch (e) {
    return jsonOut({ ok: false, fehler: String(e && (e as Error).message || e), hinweise: notes }, 500);
  }
});
