// whoop-sync — holt Recovery / Sleep / Cycles von der Whoop API v2
// Aufruf: ?key=SYNC_KEY [&days=N]   (N Standard 7, max 25)
//
// 14.09.2026 — Ueberarbeitung nach 4 Token-Ausfaellen in 6 Tagen:
// Der Fehler kam jedesmal als sauberes "400 invalid_request" DIREKT
// von Whoop zurueck, nie als Verbindungsabbruch. Das spricht GEGEN
// einen reinen Cloudflare-502-Netzwerkfehler (Verdacht vom 09.09.) und
// FUER eine Race Condition: Whoop rotiert den Refresh-Token bei jedem
// Tausch und invalidiert den alten sofort. Wenn zwei Aufrufe (z.B. der
// stuendliche Cron + ein manueller Testaufruf) ueberlappend denselben
// alten Token lesen, gewinnt einer, der andere sendet einen bereits
// verbrauchten Token und scheitert -- mit genau diesem Fehlerbild.
//
// Gegenmassnahmen:
// 1) Lock ueber refresh_lock_at: Ein Refresh, der vor <20s gestartet
//    wurde, blockiert einen zweiten parallelen Versuch. Der zweite
//    wartet kurz und liest dann den (hoffentlich frischen) Token neu.
// 2) Retry bei Fehler: Token wird nach einem Fehlschlag NEU aus der DB
//    gelesen (koennte durch den parallelen Prozess erfolgreich erneuert
//    worden sein) und einmal erneut versucht, bevor die Funktion aufgibt.
// 3) sync_health_log: echte Historie statt nur des letzten Zustands,
//    damit sich Haeufigkeit und Muster kuenftig nachvollziehen lassen.

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function berlinDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return p;
}

function hours(milli: number | null | undefined): number | null {
  if (milli === null || milli === undefined) return null;
  return Math.round((milli / 3600000) * 100) / 100;
}

function majorityDay(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso) return null;
  if (!endIso) return berlinDay(new Date().toISOString());

  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!isFinite(start) || !isFinite(end) || end <= start) return berlinDay(endIso);

  const tally: Record<string, number> = {};
  let t = start;
  while (t < end) {
    const step = Math.min(3600000, end - t);
    const day = berlinDay(new Date(t + step / 2).toISOString());
    if (day) tally[day] = (tally[day] || 0) + step;
    t += step;
  }
  let bestDay: string | null = null, bestMs = -1;
  for (const d of Object.keys(tally)) {
    if (tally[d] > bestMs) { bestMs = tally[d]; bestDay = d; }
  }
  return bestDay;
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

async function pingHealth(ok: boolean, errorMsg: string | null) {
  try {
    const row: Record<string, unknown> = {
      service: 'whoop',
      last_error: ok ? null : errorMsg,
      last_error_at: ok ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (ok) row.last_ok_at = new Date().toISOString();
    await fetch(SB_URL + '/rest/v1/sync_health?on_conflict=service', {
      method: 'POST',
      headers: Object.assign({}, SB_HEAD, { prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([row]),
    });
    // Historie zusaetzlich zum reinen Ist-Zustand, damit sich Haeufigkeit
    // und Zeitpunkte spaeter nachvollziehen lassen (sync_health selbst
    // haelt nur den letzten Stand, kein Log).
    await fetch(SB_URL + '/rest/v1/sync_health_log', {
      method: 'POST',
      headers: Object.assign({}, SB_HEAD, { prefer: 'return=minimal' }),
      body: JSON.stringify([{ service: 'whoop', ok, error: ok ? null : errorMsg }]),
    });
  } catch (_e) { /* darf den Sync nicht stoppen */ }
}

async function readTokenRow(): Promise<any> {
  const r = await fetch(SB_URL + '/rest/v1/whoop_tokens?id=eq.1&select=*', { headers: SB_HEAD });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Keine Tokens in whoop_tokens. Erst whoop-callback aufrufen.');
  }
  return rows[0];
}

async function doRefresh(refreshToken: string): Promise<any> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
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
  if (!res.ok) {
    const err: any = new Error('Token-Refresh fehlgeschlagen (HTTP ' + res.status + '): ' + txt.slice(0, 200));
    err.httpStatus = res.status;
    throw err;
  }
  return JSON.parse(txt);
}

async function saveToken(tok: any, fallbackRefresh: string) {
  const save = await fetch(SB_URL + '/rest/v1/whoop_tokens?on_conflict=id', {
    method: 'POST',
    headers: Object.assign({}, SB_HEAD, { prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{
      id: 1,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || fallbackRefresh,
      expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
      refresh_lock_at: null,
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!save.ok) throw new Error('Neuer Token konnte NICHT gespeichert werden — Abbruch vor Abfrage.');
}

async function setLock() {
  await fetch(SB_URL + '/rest/v1/whoop_tokens?id=eq.1', {
    method: 'PATCH',
    headers: Object.assign({}, SB_HEAD, { prefer: 'return=minimal' }),
    body: JSON.stringify({ refresh_lock_at: new Date().toISOString() }),
  });
}

async function clearLock() {
  await fetch(SB_URL + '/rest/v1/whoop_tokens?id=eq.1', {
    method: 'PATCH',
    headers: Object.assign({}, SB_HEAD, { prefer: 'return=minimal' }),
    body: JSON.stringify({ refresh_lock_at: null }),
  });
}

async function getAccessToken(notes: string[]): Promise<string> {
  let t = await readTokenRow();
  const expMs = t.expires_at ? new Date(t.expires_at).getTime() : 0;

  if (expMs > Date.now() + 120000 && t.access_token) {
    notes.push('Access-Token noch gueltig');
    return t.access_token;
  }

  // Lock-Check: laeuft gerade ein anderer Refresh (angestossen < 20s)?
  const lockMs = t.refresh_lock_at ? new Date(t.refresh_lock_at).getTime() : 0;
  if (lockMs && Date.now() - lockMs < 20000) {
    notes.push('Anderer Refresh laeuft bereits — warte kurz und lese neu');
    await sleep(4000);
    t = await readTokenRow();
    const expMs2 = t.expires_at ? new Date(t.expires_at).getTime() : 0;
    if (expMs2 > Date.now() + 60000 && t.access_token) {
      notes.push('Token wurde vom parallelen Prozess bereits erneuert');
      return t.access_token;
    }
    // sonst normal weitermachen, evtl. ist der andere Prozess gescheitert
  }

  if (!t.refresh_token) throw new Error('Kein Refresh-Token gespeichert.');

  await setLock();
  try {
    let tok;
    try {
      tok = await doRefresh(t.refresh_token);
    } catch (firstErr) {
      // Retry: Token frisch aus der DB lesen (koennte inzwischen von
      // einem parallelen Aufruf erneuert worden sein) und einmal erneut
      // versuchen, statt sofort aufzugeben.
      notes.push('Erster Refresh-Versuch fehlgeschlagen, versuche erneut mit frischem Token');
      await sleep(1500);
      const fresh = await readTokenRow();
      const freshExp = fresh.expires_at ? new Date(fresh.expires_at).getTime() : 0;
      if (freshExp > Date.now() + 60000 && fresh.access_token) {
        notes.push('Frischer Token war bereits da (paralleler Prozess war erfolgreich)');
        return fresh.access_token;
      }
      if (fresh.refresh_token === t.refresh_token) {
        // gleicher Token wie beim ersten Versuch -> kein anderer Prozess
        // war erfolgreich, wirklich erneut mit demselben Token versuchen
        tok = await doRefresh(fresh.refresh_token);
      } else {
        tok = await doRefresh(fresh.refresh_token);
      }
      notes.push('Zweiter Refresh-Versuch erfolgreich');
    }

    await saveToken(tok, t.refresh_token);
    notes.push('Token erneuert' + (tok.refresh_token ? ' (Refresh-Token rotiert)' : ''));
    return tok.access_token;
  } finally {
    await clearLock();
  }
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

    const byDay: Record<string, Record<string, any>> = {};
    const put = (day: string | null, patch: Record<string, any>) => {
      if (!day) return;
      if (!byDay[day]) byDay[day] = { day: day };
      Object.assign(byDay[day], patch);
    };

    const sleepDayById: Record<string, string> = {};
    const sleepData = await whoopGet('/activity/sleep', token, range);
    for (const rec of (sleepData.records || [])) {
      if (rec.nap) continue;
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
    notes.push('Sleep: ' + (sleepData.records || []).length + ' Datensaetze');

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

    const cyc = await whoopGet('/cycle', token, range);
    const cycles = (cyc.records || []).slice().sort(function (a, b) {
      return (a.end ? 1 : 0) - (b.end ? 1 : 0);
    });
    for (const rec of cycles) {
      const offen = !rec.end;
      const day = majorityDay(rec.start, rec.end);
      const s = rec.score || {};
      put(day, {
        cycle_id: String(rec.id),
        cycle_start: rec.start || null,
        cycle_open: offen,
        day_strain: round(s.strain, 2),
        avg_hr: round(s.average_heart_rate, 0),
        max_hr: round(s.max_heart_rate, 0),
        kcal_out_whoop: s.kilojoule ? round(s.kilojoule / 4.184, 0) : null,
      });
    }
    notes.push('Cycles: ' + cycles.length + ' Datensaetze');

    try {
      const bm = await whoopGet('/user/measurement/body', token, {});
      put(berlinDay(new Date().toISOString()), {
        profile_weight_kg: round(bm.weight_kilogram, 1),
        profile_height_m:  round(bm.height_meter, 2),
        profile_max_hr:    round(bm.max_heart_rate, 0),
      });
      notes.push('Profil: ' + bm.weight_kilogram + ' kg · max ' + bm.max_heart_rate + ' bpm');
    } catch (e) {
      notes.push('Body-Measurement nicht abrufbar: ' + String(e));
    }

    const rows = Object.keys(byDay).sort().map((d) => {
      byDay[d].updated_at = new Date().toISOString();
      return byDay[d];
    });

    const written = rows.length ? await upsertDaily(rows) : 0;

    await pingHealth(true, null);

    return jsonOut({
      ok: true,
      zeitraum_tage: days,
      tage_geschrieben: written,
      tage: rows.map((r) => r.day),
      hinweise: notes,
    });
  } catch (e) {
    const msg = String(e && (e as Error).message || e);
    try { await clearLock(); } catch (_e) { /* egal */ }
    await pingHealth(false, msg);
    return jsonOut({ ok: false, fehler: msg, hinweise: notes }, 500);
  }
});
