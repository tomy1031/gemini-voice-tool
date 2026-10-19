// 画面の 動き。台本と 設定は localStorage、作った 音は IndexedDB に 置く（再読み込みしても 残る）。
import * as core from "./core.js?v=4";
import { VOICES } from "./voices.js?v=4";

const $ = (sel) => document.querySelector(sel);
const KEY_STORE = "gvt.apiKey";
const PROJECT_STORE = "gvt.project";
const MODELS_STORE = "gvt.models";

const DEFAULT_SETTINGS = {
  textModel: "gemini-3.8-flash",
  engine: "live",
  liveModel: "gemini-3.8-live",
  ttsModel: "gemini-3.8-flash-tts",
  checkModel: "gemini-3.5-flash-lite",
  check: true,
  style: "",
  gap: 1.2,
  tempo: 1,
};

/** モデル一覧を 取る 前に 出す 候補（取れたら 置きかえる）。 */
const FALLBACK_MODELS = {
  text: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  live: ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025"],
  tts: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts"],
};

/* ------------------------------------------------------------------ *
 * 保存
 * ------------------------------------------------------------------ */

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できない（プライベートモードなど）ときは この画面の あいだだけ 覚える
  }
}
function lsDel(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

const emptyProject = () => ({ settings: { ...DEFAULT_SETTINGS }, request: "", manuscript: "", pauseInstruction: "", characters: [], rows: [], notes: [] });

function loadProject() {
  try {
    const saved = JSON.parse(lsGet(PROJECT_STORE) ?? "null");
    if (saved && Array.isArray(saved.rows)) return { ...emptyProject(), ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
  } catch {
    // 壊れて いたら 新しく 始める
  }
  return emptyProject();
}

let saveTimer = 0;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => lsSet(PROJECT_STORE, JSON.stringify(state)), 300);
}

/** 作った 音（生PCM）の 置き場。 */
const dbReady = new Promise((resolve) => {
  try {
    const open = indexedDB.open("gemini-voice-tool", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("clips");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
  } catch {
    resolve(null);
  }
});
/** IndexedDB が 使えない ときの 控え（この 画面の あいだだけ）。 */
const memoryClips = new Map();

async function clipStore(mode, fn) {
  const db = await dbReady;
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("clips", mode);
    const request = fn(tx.objectStore("clips"));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const clipGet = async (id) => {
  const value = await clipStore("readonly", (store) => (store ? store.get(id) : null));
  const found = value ?? memoryClips.get(id);
  return found ? new Uint8Array(found) : null;
};
const clipPut = async (id, pcm) => {
  memoryClips.set(id, pcm);
  await clipStore("readwrite", (store) => store?.put(pcm, id));
};
const clipDel = async (id) => {
  memoryClips.delete(id);
  await clipStore("readwrite", (store) => store?.delete(id));
};
const clipClear = async () => {
  memoryClips.clear();
  await clipStore("readwrite", (store) => store?.clear());
};

/* ------------------------------------------------------------------ *
 * 状態
 * ------------------------------------------------------------------ */

let state = loadProject();
let running = false;
let stopRequested = false;
const busy = new Set();

const getKey = () => (lsGet(KEY_STORE) ?? "").trim();
const newId = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const characterOf = (id) => state.characters.find((c) => c.id === id);
const voiceOf = (speaker) => characterOf(speaker)?.voice ?? "Zephyr";
const engineModel = () => (state.settings.engine === "tts" ? state.settings.ttsModel : state.settings.liveModel);

/** 音が 今の 行に 合って いるかの 目じるし（声・文・話し方）。エンジンを 変えただけでは 作り直さない。 */
const hashOf = (row) => [voiceOf(row.speaker), row.say.trim(), state.settings.style.trim()].join("|");

function statusOf(row) {
  if (busy.has(row.id)) return "busy";
  if (row.clip && row.clip.hash !== hashOf(row)) return "stale";
  if (row.error) return "error";
  if (!row.clip) return "none";
  return row.clip.flag === "check" ? "check" : "ok";
}
const STATUS_LABEL = { busy: "作成中…", stale: "変更あり", error: "エラー", none: "未作成", check: "要確認", ok: "OK" };

/* ------------------------------------------------------------------ *
 * 小さな 道具
 * ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(message, ms = 4500) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

let playerUrl = "";
async function playPcm(pcm) {
  const player = $("#player");
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(new Blob([core.pcmToWav(pcm)], { type: "audio/wav" }));
  player.src = playerUrl;
  player.hidden = false;
  await player.play().catch(() => {});
}
function playUrl(url) {
  const player = $("#player");
  player.src = url;
  player.hidden = false;
  player.play().catch(() => toast("見本を 再生できませんでした"));
}

function download(bytes, name, type = "audio/wav") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s。、「」！？!?]/g, "").slice(0, 16);

const applyTempo = (pcm) => (state.settings.tempo === 1 ? pcm : core.fadeEdges(core.timeStretch(pcm, state.settings.tempo)));

const formatSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, "0")}秒` : `${s.toFixed(1)}秒`);

/* ------------------------------------------------------------------ *
 * 描く
 * ------------------------------------------------------------------ */

function renderKeyBadge() {
  const badge = $("#key-badge");
  const has = Boolean(getKey());
  badge.textContent = has ? "APIキー登録済み" : "APIキー未登録";
  badge.classList.toggle("ok", has);
}

function fillDatalists() {
  let cached = null;
  try {
    cached = JSON.parse(lsGet(MODELS_STORE) ?? "null");
  } catch {
    cached = null;
  }
  const lists = cached ?? FALLBACK_MODELS;
  for (const [kind, id] of [["text", "#text-models"], ["live", "#live-models"], ["tts", "#tts-models"]]) {
    $(id).innerHTML = (lists[kind] ?? []).map((m) => `<option value="${esc(m)}"></option>`).join("");
  }
}

function voiceOptions(selected) {
  const group = (gender, label) =>
    `<optgroup label="${label}">${VOICES.filter((v) => v.gender === gender)
      .map((v) => `<option value="${v.name}" ${v.name === selected ? "selected" : ""}>${v.name}（${esc(v.style)}）</option>`)
      .join("")}</optgroup>`;
  return group("female", "女性") + group("male", "男性");
}

function renderCharacters() {
  const box = $("#characters");
  if (!state.characters.length) {
    box.innerHTML = `<p class="empty">台本を作ると、ここに話し手が出ます。</p>`;
    return;
  }
  box.innerHTML = state.characters
    .map((c) => {
      const count = state.rows.filter((r) => r.speaker === c.id).length;
      return `<div class="character" data-id="${esc(c.id)}">
        <div class="head"><span class="id">${esc(c.id)}</span><input class="name" value="${esc(c.name)}" aria-label="話し手の名前" /></div>
        <div class="voice-row"><select class="voice" aria-label="声">${voiceOptions(c.voice)}</select><button type="button" class="sample small ghost">▶ 見本</button></div>
        ${c.reason ? `<div class="reason">AI: ${esc(c.reason)}</div>` : ""}
        <div class="reason">${count}文</div>
      </div>`;
    })
    .join("");
}

function speakerOptions(selected) {
  return state.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("");
}

function rowHtml(row, index) {
  const showOrig = row.text && core.normalizeForCompare(row.text) !== core.normalizeForCompare(row.say);
  return `<div class="line" data-id="${row.id}">
    <input type="checkbox" class="pick" aria-label="選ぶ" />
    <div class="no">${index + 1}</div>
    <select class="sel speaker" aria-label="話し手">${speakerOptions(row.speaker)}</select>
    <div class="text">
      <textarea class="say" rows="1" aria-label="読み上げる文">${esc(row.say)}</textarea>
      ${showOrig ? `<div class="orig">原稿: ${esc(row.text)}</div>` : ""}
      <div class="heard"></div>
    </div>
    <label class="gap">後の間<input type="number" class="gap-input" min="0" max="10" step="0.1" placeholder="既定" value="${row.gapAfter ?? ""}" /></label>
    <div class="state"><span class="chip"></span></div>
    <div class="buttons">
      <button type="button" class="play" title="再生">▶</button>
      <button type="button" class="redo" title="この行を作り直す">↻</button>
      <button type="button" class="dl" title="この行をWAVで保存">⬇</button>
      <button type="button" class="add" title="下に行を足す">＋</button>
      <button type="button" class="del" title="行を消す">✕</button>
    </div>
  </div>`;
}

function updateRowState(row) {
  const el = document.querySelector(`.line[data-id="${row.id}"]`);
  if (!el) return;
  const status = statusOf(row);
  const chip = el.querySelector(".chip");
  chip.className = `chip ${status}`;
  chip.textContent = STATUS_LABEL[status];
  el.classList.toggle("busy", status === "busy");
  const heard = el.querySelector(".heard");
  let note = "";
  if (row.error && status !== "busy") note = row.error;
  else if (row.clip?.transcript) {
    const pct = row.clip.match == null ? "" : `（一致 ${Math.round(row.clip.match * 100)}%）`;
    note = `聞き取り: ${row.clip.transcript}${pct}`;
  } else if (row.clip?.why) note = row.clip.why;
  if (row.clip?.flag === "check" && row.clip.why && !row.error) note = `${row.clip.why}`;
  heard.textContent = note;
  heard.classList.toggle("bad", status === "check" || status === "error");
  el.querySelector(".play").disabled = !row.clip;
  el.querySelector(".dl").disabled = !row.clip;
  el.querySelector(".redo").disabled = running;
}

function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function renderRows() {
  const box = $("#rows");
  if (!state.rows.length) {
    box.innerHTML = `<p class="empty">まだ台本がありません。1 で「台本にする」を押してください。</p>`;
  } else {
    box.innerHTML = state.rows.map(rowHtml).join("");
    state.rows.forEach(updateRowState);
    box.querySelectorAll("textarea.say").forEach(autosize);
  }
  renderSummary();
}

function renderSummary() {
  const counts = { ok: 0, check: 0, stale: 0, none: 0, error: 0, busy: 0 };
  let seconds = 0;
  let clips = 0;
  for (const row of state.rows) {
    counts[statusOf(row)] += 1;
    if (row.clip) {
      seconds += row.clip.seconds / state.settings.tempo;
      clips += 1;
    }
  }
  // 音には 頭と おしりの 余白が ふくまれて いるので、つなぐ ときと 同じく その ぶんを 引く
  const margin = (core.HEAD_MS + core.TAIL_MS) / 1000;
  const gaps = state.rows.slice(0, -1).reduce((sum, r) => sum + Math.max(0, (r.gapAfter ?? state.settings.gap) - margin), 0);
  $("#summary").textContent = state.rows.length
    ? `全${state.rows.length}文：OK ${counts.ok}・要確認 ${counts.check}・変更あり ${counts.stale}・未作成 ${counts.none}・エラー ${counts.error}` +
      (clips ? `｜全体の長さ 約${formatSeconds(seconds + (clips > 1 ? gaps : 0))}` : "")
    : "";
}

function renderEngineNote() {
  const s = state.settings;
  $("#engine-note").textContent =
    s.engine === "tts"
      ? `Gemini TTS（${s.ttsModel}）で、2人ずつまとめて読みます。`
      : `Gemini Live（${s.liveModel}）で1文ずつ作ります${s.check ? "（読み上げチェックあり）" : ""}。`;
}

function renderNotes() {
  const box = $("#notes-box");
  box.hidden = !state.notes.length;
  $("#notes").innerHTML = state.notes.map((n) => `<li>${esc(n)}</li>`).join("");
}

function renderAll() {
  $("#request").value = state.request;
  $("#manuscript").value = state.manuscript;
  $("#text-model").value = state.settings.textModel;
  $("#tempo").value = state.settings.tempo;
  $("#tempo-out").textContent = Number(state.settings.tempo).toFixed(2);
  $("#gap").value = state.settings.gap;
  $("#pause-instruction").value = state.pauseInstruction ?? "";
  renderKeyBadge();
  renderNotes();
  renderCharacters();
  renderRows();
  renderEngineNote();
}

function setRunning(on) {
  running = on;
  $("#generate-all").disabled = on;
  $("#regenerate-selected").disabled = on;
  $("#make-script").disabled = on;
  $("#stop").disabled = !on;
  $("#progress").hidden = !on && !$("#progress-text").textContent;
  document.querySelectorAll(".line .redo").forEach((b) => (b.disabled = on));
}

function setProgress(done, total, label = "") {
  $("#progress").hidden = false;
  $("#progress-bar").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("#progress-text").textContent = `${done} / ${total}${label ? ` ${label}` : ""}`;
}

/* ------------------------------------------------------------------ *
 * 台本を 作る
 * ------------------------------------------------------------------ */

function requireKey() {
  const key = getKey();
  if (!key) {
    toast("先に「⚙ 設定」で Gemini APIキーを登録してください");
    openSettings();
  }
  return key;
}

async function onMakeScript() {
  const apiKey = requireKey();
  if (!apiKey) return;
  state.request = $("#request").value;
  state.manuscript = $("#manuscript").value;
  state.settings.textModel = $("#text-model").value.trim() || DEFAULT_SETTINGS.textModel;
  if (!state.manuscript.trim()) {
    toast("原稿を貼ってください");
    return;
  }
  if (state.rows.length && !confirm("今の台本と作った音は消えます。新しく台本を作りますか？")) return;
  const status = $("#script-status");
  status.classList.remove("bad");
  status.textContent = `台本を作っています（${state.settings.textModel}）…30秒〜1分ほどかかります`;
  $("#make-script").disabled = true;
  try {
    const result = await core.makeScript(apiKey, state.settings.textModel, {
      request: state.request,
      manuscript: state.manuscript,
      voices: VOICES,
      gap: state.settings.gap,
    });
    await clipClear();
    state.characters = result.characters;
    state.notes = result.notes;
    state.rows = result.lines.map((line) => ({ id: newId(), speaker: line.speaker, say: line.say, text: line.text, gapAfter: line.pauseAfter ?? null, clip: null, error: "" }));
    saveProject();
    renderAll();
    const pauses = state.rows.filter((r) => r.gapAfter !== null).length;
    status.textContent =
      `${state.rows.length}文・話し手${state.characters.length}人の台本ができました` +
      (pauses ? `（後の間を${pauses}か所で調整）` : "") +
      "。声を確かめてから「出力する」を押してください。";
    $("#step-voices").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    status.classList.add("bad");
    status.textContent = `台本を作れませんでした: ${error.message}`;
  } finally {
    $("#make-script").disabled = running;
  }
}

/** 今の 台本の 後の間だけを AI に 決めて もらう（文と 作った 音は そのまま）。 */
async function onSuggestPauses() {
  if (!state.rows.length) return toast("先に台本を作ってください");
  const apiKey = requireKey();
  if (!apiKey) return;
  state.pauseInstruction = $("#pause-instruction").value;
  const status = $("#pause-status");
  const button = $("#suggest-pauses");
  status.classList.remove("bad");
  status.textContent = `後の間を決めています（${state.settings.textModel}）…`;
  button.disabled = true;
  try {
    const { gaps, notes } = await core.suggestPauses(apiKey, state.settings.textModel, {
      request: state.request,
      instruction: state.pauseInstruction,
      gap: state.settings.gap,
      rows: state.rows.map((r) => ({ speaker: characterOf(r.speaker)?.name ?? r.speaker, say: r.say })),
    });
    state.rows.forEach((row, i) => (row.gapAfter = gaps[i]));
    saveProject();
    renderRows();
    const changed = gaps.filter((g) => g !== null).length;
    status.textContent =
      `${changed}か所の後の間を変えました（ほかは既定の ${state.settings.gap}秒）。作った音はそのまま使えます。` +
      (notes.length ? `\n${notes.map((n) => `・${n}`).join("\n")}` : "");
  } catch (error) {
    status.classList.add("bad");
    status.textContent = `後の間を決められませんでした: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * 音を 作る
 * ------------------------------------------------------------------ */

/** 読み上げが 台本どおりか（Live）。 */
function judge(row, pcm, transcript) {
  const seconds = core.pcmSeconds(pcm);
  const length = core.normalizeForCompare(row.say).length || 1;
  if (!transcript) {
    const perChar = seconds / length;
    const ok = perChar >= 0.05 && perChar <= 0.45;
    return { ok, match: null, why: ok ? "聞き取りで確かめられませんでした（長さは合っています）" : `長さが合いません（${seconds.toFixed(1)}秒）` };
  }
  const match = core.readingMatch([row.say, row.text], transcript);
  const tooLong = core.normalizeForCompare(transcript).length > length * 1.6 + 2;
  // 短い 文は 答えて しまった 音（「何歳ですか」→「28歳です」）でも 一致が 高く 出やすい
  const ok = match >= (length <= 8 ? 0.75 : 0.6) && !tooLong;
  return { ok, match, why: ok ? "" : `台本と合いません（一致 ${Math.round(match * 100)}%）: ${transcript}` };
}

async function speakLiveRow(apiKey, row) {
  const say = row.say.trim();
  if (!say) throw new Error("文が空です");
  const hash = hashOf(row);
  const voice = voiceOf(row.speaker);
  const { liveModel: model, check, checkModel, style } = state.settings;
  let best = null;
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (stopRequested) break;
    if (attempt > 0) await sleep(4000);
    let result;
    try {
      // 2回目からは「」で 囲む（短い 文を 話しかけと 取りちがえて 返事を する ことが ある）
      result = await core.liveSpeak(apiKey, model, { text: attempt === 0 ? say : `「${say}」`, voice, style });
    } catch (error) {
      if (error.quota) throw error;
      failures.push(error.message);
      continue;
    }
    const pcm = core.fadeEdges(core.trimSilence(result.pcm));
    let transcript = result.transcript;
    if (check && !transcript) {
      try {
        transcript = await core.transcribe(apiKey, checkModel, pcm);
      } catch (error) {
        failures.push(`文字起こし: ${error.message}`);
      }
    }
    const verdict = check ? judge(row, pcm, transcript) : { ok: true, match: null, why: "" };
    const score = (verdict.ok ? 2 : 0) + (verdict.match ?? 0.5);
    if (!best || score > best.score) best = { pcm, transcript, ...verdict, score };
    // 文字起こしが 取れない ときは 長さだけ 見て 終える（要確認に する）
    if (verdict.ok) break;
    failures.push(verdict.why);
  }
  if (!best) throw new Error(failures.join(" / ") || "止めました");
  if (!state.rows.includes(row)) return;
  await clipPut(row.id, best.pcm);
  row.clip = {
    hash,
    seconds: core.pcmSeconds(best.pcm),
    transcript: best.transcript,
    match: best.match,
    // 確かめられなかった 音・合わなかった 音は「要確認」（耳で 聞いて ↻ で 作り直せる）
    flag: !check || (best.ok && best.match !== null) ? "ok" : "check",
    why: best.why,
    engine: "live",
    model,
  };
  row.error = "";
}

/** TTS で まとめて 読む 組に 分ける（並んで いる 行・2人まで・25文まで）。 */
function ttsGroups(targets) {
  const groups = [];
  let current = [];
  const at = (row) => state.rows.indexOf(row);
  for (const row of targets) {
    const last = current[current.length - 1];
    const speakers = new Set([...current.map((r) => r.speaker), row.speaker]);
    const chars = current.reduce((sum, r) => sum + r.say.length, 0) + row.say.length;
    if (current.length && (at(row) !== at(last) + 1 || speakers.size > 2 || chars > 1500 || current.length >= 25)) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) groups.push(current);
  return groups;
}

async function speakTtsGroup(apiKey, group) {
  const { ttsModel: model, style } = state.settings;
  const hashes = group.map(hashOf);
  const speakers = [...new Set(group.map((r) => r.speaker))];
  const voices = Object.fromEntries(speakers.map((s) => [s, voiceOf(s)]));
  const lines = group.map((r, i) => ({ speaker: r.speaker, text: r.say.trim() + (i < group.length - 1 ? ` ${core.LONG_PAUSE}` : "") }));
  const pcm = await core.ttsSpeak(apiKey, model, { lines, voices, style });
  let pieces;
  if (group.length === 1) pieces = [core.trimSilence(pcm)];
  else {
    const split = core.splitDialogue(pcm, group.map((r) => core.normalizeForCompare(r.say).length || 1));
    if (!split.pieces) throw new Error(`まとめて読んだ音を1文ずつに切れませんでした（${split.why}）。↻ で1文ずつ作り直せます`);
    pieces = split.pieces;
  }
  for (const [i, row] of group.entries()) {
    if (!state.rows.includes(row)) continue;
    const clip = core.fadeEdges(pieces[i]);
    await clipPut(row.id, clip);
    row.clip = { hash: hashes[i], seconds: core.pcmSeconds(clip), transcript: "", match: null, flag: "ok", why: "", engine: "tts", model };
    row.error = "";
  }
}

async function generate(targets) {
  if (running) return;
  if (!targets.length) {
    toast("作る行はありません（すべて作成済みです）。作り直すときは行を選んで「選んだ行を作り直す」か ↻ を押してください");
    return;
  }
  const apiKey = requireKey();
  if (!apiKey) return;
  const empty = targets.find((r) => !r.say.trim());
  if (empty) {
    toast(`${state.rows.indexOf(empty) + 1}行目の文が空です`);
    return;
  }
  setRunning(true);
  stopRequested = false;
  const total = targets.length;
  let done = 0;
  setProgress(0, total, "作成中…");
  const fail = (rows, error) => {
    for (const row of rows) row.error = error.message;
    if (error.quota) {
      stopRequested = true;
      toast(`使える回数の上限に達したようです。時間をおいてから、残りを「出力する」で作ってください。\n${error.message}`, 9000);
    }
  };
  try {
    if (state.settings.engine === "tts") {
      const groups = ttsGroups(targets);
      for (const [g, group] of groups.entries()) {
        if (stopRequested) break;
        if (g > 0) await sleep(3000);
        group.forEach((r) => busy.add(r.id));
        group.forEach(updateRowState);
        try {
          await speakTtsGroup(apiKey, group);
        } catch (error) {
          fail(group, error);
        }
        group.forEach((r) => busy.delete(r.id));
        group.forEach(updateRowState);
        done += group.length;
        setProgress(done, total, `作成中…（TTS ${g + 1}/${groups.length}回目）`);
        renderSummary();
        saveProject();
      }
    } else {
      for (const [i, row] of targets.entries()) {
        if (stopRequested) break;
        if (i > 0) await sleep(2500);
        busy.add(row.id);
        updateRowState(row);
        try {
          await speakLiveRow(apiKey, row);
        } catch (error) {
          fail([row], error);
        }
        busy.delete(row.id);
        updateRowState(row);
        done += 1;
        setProgress(done, total, "作成中…");
        renderSummary();
        saveProject();
      }
    }
  } finally {
    busy.clear();
    setRunning(false);
    state.rows.forEach(updateRowState);
    renderSummary();
    saveProject();
    const counts = targets.reduce((acc, r) => ((acc[statusOf(r)] = (acc[statusOf(r)] ?? 0) + 1), acc), {});
    setProgress(done, total, stopRequested ? "止めました" : `終わりました（OK ${counts.ok ?? 0}・要確認 ${counts.check ?? 0}・エラー ${counts.error ?? 0}）`);
  }
}

/* ------------------------------------------------------------------ *
 * 書き出し
 * ------------------------------------------------------------------ */

async function buildAll() {
  const parts = [];
  const gaps = [];
  let missing = 0;
  let stale = 0;
  for (const row of state.rows) {
    const pcm = row.clip ? await clipGet(row.id) : null;
    if (!pcm) {
      missing += 1;
      continue;
    }
    if (statusOf(row) === "stale") stale += 1;
    parts.push(applyTempo(pcm));
    gaps.push(row.gapAfter ?? null);
  }
  const notes = [];
  if (missing) notes.push(`音のない行が${missing}行あります（飛ばしてつなぎました）`);
  if (stale) notes.push(`「変更あり」の行が${stale}行あります（古い音のままです）`);
  return { pcm: parts.length ? core.joinClips(parts, state.settings.gap, gaps) : null, notes };
}

async function onPlayAll() {
  const { pcm, notes } = await buildAll();
  if (!pcm) return toast("まだ音がありません。「出力する」を押してください");
  if (notes.length) toast(notes.join("\n"));
  await playPcm(pcm);
}

async function onDownloadAll() {
  const { pcm, notes } = await buildAll();
  if (!pcm) return toast("まだ音がありません。「出力する」を押してください");
  if (notes.length) toast(notes.join("\n"));
  download(core.pcmToWav(pcm), `voice_${stamp()}.wav`);
}

async function onDownloadZip() {
  if (!window.JSZip) return toast("ZIPの部品を読み込めませんでした（ネットにつながっているか確かめてください）");
  const zip = new window.JSZip();
  let count = 0;
  for (const [i, row] of state.rows.entries()) {
    const pcm = row.clip ? await clipGet(row.id) : null;
    if (!pcm) continue;
    const name = `${String(i + 1).padStart(3, "0")}_${safeName(characterOf(row.speaker)?.name ?? row.speaker)}_${safeName(row.say)}.wav`;
    zip.file(name, core.pcmToWav(applyTempo(pcm)));
    count += 1;
  }
  if (!count) return toast("まだ音がありません");
  const { pcm } = await buildAll();
  if (pcm) zip.file("000_全体.wav", core.pcmToWav(pcm));
  zip.file("台本.json", JSON.stringify(projectForExport(), null, 2));
  const blob = await zip.generateAsync({ type: "uint8array" });
  download(blob, `voice_${stamp()}.zip`, "application/zip");
}

function projectForExport() {
  return {
    tool: "gemini-voice-tool",
    version: 1,
    settings: state.settings,
    request: state.request,
    manuscript: state.manuscript,
    pauseInstruction: state.pauseInstruction ?? "",
    characters: state.characters,
    notes: state.notes,
    rows: state.rows.map(({ id, speaker, say, text, gapAfter }) => ({ id, speaker, say, text, gapAfter })),
  };
}

async function onImportProject(file) {
  try {
    const json = JSON.parse(await file.text());
    if (!Array.isArray(json.rows) || !Array.isArray(json.characters)) throw new Error("この ツールの 台本では ありません");
    if (state.rows.length && !confirm("今の台本と作った音は消えます。読み込みますか？")) return;
    await clipClear();
    state = {
      ...emptyProject(),
      settings: { ...DEFAULT_SETTINGS, ...json.settings },
      request: json.request ?? "",
      manuscript: json.manuscript ?? "",
      pauseInstruction: json.pauseInstruction ?? "",
      characters: json.characters,
      notes: json.notes ?? [],
      rows: json.rows.map((r) => ({ id: r.id ?? newId(), speaker: r.speaker, say: r.say ?? "", text: r.text ?? "", gapAfter: r.gapAfter ?? null, clip: null, error: "" })),
    };
    saveProject();
    renderAll();
    toast(`${state.rows.length}文の台本を読み込みました`);
  } catch (error) {
    toast(`読み込めませんでした: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 設定
 * ------------------------------------------------------------------ */

function openSettings() {
  const s = state.settings;
  $("#api-key").value = getKey();
  document.querySelectorAll('input[name="engine"]').forEach((r) => (r.checked = r.value === s.engine));
  $("#live-model").value = s.liveModel;
  $("#tts-model").value = s.ttsModel;
  $("#check-model").value = s.checkModel;
  $("#check").checked = s.check;
  $("#style").value = s.style;
  $("#key-status").textContent = "";
  $("#settings").showModal();
}

function readSettings() {
  const s = state.settings;
  s.engine = document.querySelector('input[name="engine"]:checked')?.value ?? "live";
  s.liveModel = $("#live-model").value.trim() || DEFAULT_SETTINGS.liveModel;
  s.ttsModel = $("#tts-model").value.trim() || DEFAULT_SETTINGS.ttsModel;
  s.checkModel = $("#check-model").value.trim() || DEFAULT_SETTINGS.checkModel;
  s.check = $("#check").checked;
  s.style = $("#style").value;
  saveProject();
  renderEngineNote();
  state.rows.forEach(updateRowState);
  renderSummary();
}

async function onTestKey() {
  const key = $("#api-key").value.trim();
  const status = $("#key-status");
  status.classList.remove("bad");
  if (!key) {
    status.textContent = "APIキーを入れてください";
    return;
  }
  status.textContent = "モデル一覧を取得しています…";
  try {
    const models = await core.listModels(key);
    const has = (m, method) => m.methods.includes(method);
    const lists = {
      text: models.filter((m) => has(m, "generateContent") && !/tts|image|embedding|audio|live|veo|imagen|aqa|robotics|computer/i.test(m.id)).map((m) => m.id),
      live: models.filter((m) => has(m, "bidiGenerateContent")).map((m) => m.id),
      tts: models.filter((m) => /tts/i.test(m.id)).map((m) => m.id),
    };
    lsSet(MODELS_STORE, JSON.stringify(lists));
    fillDatalists();
    const mark = (list, id) => (list.includes(id) ? "あり" : "見つかりません");
    status.textContent =
      `つながりました。使えるモデル ${models.length}個。\n` +
      `台本: ${state.settings.textModel} … ${mark(lists.text, state.settings.textModel)}\n` +
      `Live: ${$("#live-model").value} … ${mark(lists.live, $("#live-model").value.trim())}\n` +
      `TTS: ${$("#tts-model").value} … ${mark(lists.tts, $("#tts-model").value.trim())}`;
  } catch (error) {
    status.classList.add("bad");
    status.textContent = `つながりませんでした: ${error.message}`;
  }
}

/* ------------------------------------------------------------------ *
 * つなぐ
 * ------------------------------------------------------------------ */

function rowFromEvent(event) {
  const el = event.target.closest(".line");
  return el ? state.rows.find((r) => r.id === el.dataset.id) : null;
}

function bind() {
  $("#open-settings").addEventListener("click", openSettings);
  $("#settings").addEventListener("input", readSettings);
  $("#settings").addEventListener("change", readSettings);
  $("#save-key").addEventListener("click", () => {
    const key = $("#api-key").value.trim();
    if (!key) return toast("APIキーを入れてください");
    lsSet(KEY_STORE, key);
    renderKeyBadge();
    $("#key-status").textContent = "保存しました";
  });
  $("#delete-key").addEventListener("click", () => {
    lsDel(KEY_STORE);
    $("#api-key").value = "";
    renderKeyBadge();
    $("#key-status").textContent = "削除しました";
  });
  $("#toggle-key").addEventListener("click", () => {
    const input = $("#api-key");
    input.type = input.type === "password" ? "text" : "password";
  });
  $("#test-key").addEventListener("click", onTestKey);

  $("#request").addEventListener("input", (e) => ((state.request = e.target.value), saveProject()));
  $("#manuscript").addEventListener("input", (e) => ((state.manuscript = e.target.value), saveProject()));
  $("#text-model").addEventListener("change", (e) => ((state.settings.textModel = e.target.value.trim()), saveProject()));
  $("#load-text").addEventListener("click", () => $("#text-file").click());
  $("#text-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("#manuscript").value = state.manuscript = await file.text();
    saveProject();
    e.target.value = "";
  });
  $("#make-script").addEventListener("click", onMakeScript);

  // 話し手
  $("#characters").addEventListener("change", (e) => {
    const el = e.target.closest(".character");
    const c = el && characterOf(el.dataset.id);
    if (!c) return;
    if (e.target.classList.contains("voice")) {
      c.voice = e.target.value;
      state.rows.forEach(updateRowState);
      renderSummary();
    }
    if (e.target.classList.contains("name")) {
      c.name = e.target.value.trim() || c.id;
      document.querySelectorAll(`select.speaker option[value="${CSS.escape(c.id)}"]`).forEach((o) => (o.textContent = c.name));
    }
    saveProject();
  });
  $("#characters").addEventListener("click", (e) => {
    if (!e.target.classList.contains("sample")) return;
    const voice = e.target.closest(".character").querySelector(".voice").value;
    playUrl(`samples/${voice}.wav`);
  });
  $("#add-character").addEventListener("click", () => {
    const used = new Set(state.characters.map((c) => c.id));
    const id = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((ch) => !used.has(ch)) ?? newId();
    state.characters.push({ id, name: `${id}さん`, gender: "any", description: "", voice: "Kore", reason: "" });
    saveProject();
    renderCharacters();
    renderRows();
  });

  // 台本の 行
  const rows = $("#rows");
  rows.addEventListener("input", (e) => {
    const row = rowFromEvent(e);
    if (!row) return;
    if (e.target.classList.contains("say")) {
      row.say = e.target.value;
      autosize(e.target);
    }
    if (e.target.classList.contains("gap-input")) {
      const v = e.target.value.trim();
      row.gapAfter = v === "" ? null : Math.max(0, Number(v));
    }
    updateRowState(row);
    renderSummary();
    saveProject();
  });
  rows.addEventListener("change", (e) => {
    const row = rowFromEvent(e);
    if (!row || !e.target.classList.contains("speaker")) return;
    row.speaker = e.target.value;
    updateRowState(row);
    renderCharacters();
    renderSummary();
    saveProject();
  });
  rows.addEventListener("click", async (e) => {
    const row = rowFromEvent(e);
    const button = e.target.closest("button");
    if (!row || !button) return;
    const index = state.rows.indexOf(row);
    if (button.classList.contains("play")) {
      const pcm = await clipGet(row.id);
      if (pcm) await playPcm(applyTempo(pcm));
    } else if (button.classList.contains("redo")) {
      await generate([row]);
    } else if (button.classList.contains("dl")) {
      const pcm = await clipGet(row.id);
      if (pcm) download(core.pcmToWav(applyTempo(pcm)), `${String(index + 1).padStart(3, "0")}_${safeName(row.say)}.wav`);
    } else if (button.classList.contains("add")) {
      state.rows.splice(index + 1, 0, { id: newId(), speaker: row.speaker, say: "", text: "", gapAfter: null, clip: null, error: "" });
      saveProject();
      renderRows();
      document.querySelector(`.line[data-id="${state.rows[index + 1].id}"] textarea`)?.focus();
    } else if (button.classList.contains("del")) {
      if (row.clip && !confirm(`${index + 1}行目と、その音を消しますか？`)) return;
      state.rows.splice(index, 1);
      await clipDel(row.id);
      saveProject();
      renderRows();
      renderCharacters();
    }
  });
  $("#add-row-end").addEventListener("click", () => {
    const speaker = state.rows[state.rows.length - 1]?.speaker ?? state.characters[0]?.id;
    if (!speaker) return toast("先に台本を作るか、話し手を足してください");
    state.rows.push({ id: newId(), speaker, say: "", text: "", gapAfter: null, clip: null, error: "" });
    saveProject();
    renderRows();
    document.querySelector(`.line[data-id="${state.rows[state.rows.length - 1].id}"] textarea`)?.focus();
  });
  $("#check-all").addEventListener("change", (e) => document.querySelectorAll(".line .pick").forEach((c) => (c.checked = e.target.checked)));

  $("#generate-all").addEventListener("click", () => generate(state.rows.filter((r) => ["none", "stale", "error"].includes(statusOf(r)))));
  $("#regenerate-selected").addEventListener("click", () => {
    const picked = [...document.querySelectorAll(".line .pick:checked")].map((c) => state.rows.find((r) => r.id === c.closest(".line").dataset.id)).filter(Boolean);
    if (!picked.length) return toast("作り直す行の左のチェックを入れてください");
    generate(picked);
  });
  $("#stop").addEventListener("click", () => {
    stopRequested = true;
    $("#progress-text").textContent += "（いまの行が終わったら止めます）";
  });

  // 書き出し
  $("#tempo").addEventListener("input", (e) => {
    state.settings.tempo = Number(e.target.value);
    $("#tempo-out").textContent = state.settings.tempo.toFixed(2);
    renderSummary();
    saveProject();
  });
  $("#gap").addEventListener("input", (e) => {
    state.settings.gap = Math.max(0, Number(e.target.value) || 0);
    renderSummary();
    saveProject();
  });
  $("#pause-instruction").addEventListener("input", (e) => ((state.pauseInstruction = e.target.value), saveProject()));
  $("#suggest-pauses").addEventListener("click", onSuggestPauses);
  $("#clear-pauses").addEventListener("click", () => {
    state.rows.forEach((row) => (row.gapAfter = null));
    saveProject();
    renderRows();
    $("#pause-status").textContent = `後の間をすべて既定（${state.settings.gap}秒）に戻しました`;
  });
  $("#play-all").addEventListener("click", onPlayAll);
  $("#download-all").addEventListener("click", onDownloadAll);
  $("#download-zip").addEventListener("click", onDownloadZip);
  $("#export-project").addEventListener("click", () =>
    download(new TextEncoder().encode(JSON.stringify(projectForExport(), null, 2)), `台本_${stamp()}.json`, "application/json"),
  );
  $("#import-project").addEventListener("click", () => $("#project-file").click());
  $("#project-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) onImportProject(file);
    e.target.value = "";
  });
  $("#reset-project").addEventListener("click", async () => {
    if (!confirm("要望・原稿・台本・作った音をすべて消して、新しく始めますか？（設定とAPIキーは残ります）")) return;
    const settings = state.settings;
    state = { ...emptyProject(), settings };
    await clipClear();
    saveProject();
    renderAll();
  });

  // 台本の 欄の 幅が 変わったら 文の 欄の 高さを 合わせ直す（画面の 幅が 落ち着く 前に 描くと 縦に 長く なる）
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width === lastWidth) return;
    lastWidth = width;
    rows.querySelectorAll("textarea.say").forEach(autosize);
  }).observe(rows);

  window.addEventListener("beforeunload", (e) => {
    if (running) e.preventDefault();
  });
}

fillDatalists();
bind();
renderAll();
