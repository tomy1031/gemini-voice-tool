// 画面に よらない 部分（Gemini の 呼び出しと 音の 処理）。
// ブラウザでも Node 22 でも 動く（fetch・WebSocket・atob だけを 使う）ので、
// 鍵の ある CI から そのまま 呼んで 確かめられる。
//
// 作りかたは nexmax-academy の 音づくり（scripts/lib/live_tts.ts・gemini_tts.ts・
// split_dialogue.ts・tempo.ts）を 写した もの。

export const SAMPLE_RATE = 24000;
const API = "https://generativelanguage.googleapis.com/v1beta";
const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/* ------------------------------------------------------------------ *
 * 音（16bit・モノラル・24kHz の 生PCM を Uint8Array で 持つ）
 * ------------------------------------------------------------------ */

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function concatBytes(list) {
  const total = list.reduce((sum, one) => sum + one.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const one of list) {
    out.set(one, at);
    at += one.byteLength;
  }
  return out;
}

export const pcmSeconds = (pcm) => pcm.byteLength / SAMPLE_RATE / 2;

/** 生PCM に WAV の 頭を つける。 */
export function pcmToWav(pcm) {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** WAV（または 生PCM）から 生PCM を 取り出す。24kHz・モノラル・16bit 以外は 止める。 */
export function wavToPcm(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF") return new Uint8Array(bytes);
  let at = 12;
  let rate = SAMPLE_RATE;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(at + 10, true);
      rate = v.getUint32(at + 12, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === "data") {
      if (rate !== SAMPLE_RATE || channels !== 1 || bits !== 16) {
        throw new Error(`音の 形が ちがいます（${rate}Hz・${channels}ch・${bits}bit）`);
      }
      return bytes.slice(at + 8, Math.min(bytes.byteLength, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV に 音（data）が ありません");
}

/** 頭と おしりの 無音を 切る（少しだけ 余白を 残す）。 */
export const HEAD_MS = 60;
export const TAIL_MS = 120;
export function trimSilence(pcm, { threshold = 60, headMs = HEAD_MS, tailMs = TAIL_MS } = {}) {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  const win = Math.round(SAMPLE_RATE / 100);
  let first = -1;
  let last = -1;
  for (let at = 0; at + win <= n; at += win) {
    let sum = 0;
    for (let k = 0; k < win; k += 1) {
      const s = v.getInt16((at + k) * 2, true);
      sum += s * s;
    }
    if (Math.sqrt(sum / win) > threshold) {
      if (first < 0) first = at;
      last = at + win;
    }
  }
  if (first < 0) return pcm.slice(0, 0);
  const start = Math.max(0, first - Math.round((SAMPLE_RATE * headMs) / 1000));
  const end = Math.min(n, last + Math.round((SAMPLE_RATE * tailMs) / 1000));
  return pcm.slice(start * 2, end * 2);
}

/** 頭と おしりを なめらかに（つなぎ目で「ブツッ」と 鳴らさない）。 */
export function fadeEdges(pcm, ms = 10) {
  const out = new Uint8Array(pcm);
  const v = new DataView(out.buffer);
  const n = Math.floor(out.byteLength / 2);
  const len = Math.min(Math.round((SAMPLE_RATE * ms) / 1000), Math.floor(n / 2));
  for (let i = 0; i < len; i += 1) {
    const g = i / len;
    v.setInt16(i * 2, Math.round(v.getInt16(i * 2, true) * g), true);
    const j = n - 1 - i;
    v.setInt16(j * 2, Math.round(v.getInt16(j * 2, true) * g), true);
  }
  return out;
}

export const silence = (seconds) => new Uint8Array(Math.round(SAMPLE_RATE * Math.max(0, seconds)) * 2);

/**
 * 1文ずつの 音を つなぐ。どの 音も trimSilence 済み（頭 60ms・おしり 120ms の 余白つき）なので、
 * はさむ 無音は「声と 声の あいだが gapSeconds に なる」ように 余白の ぶんを 引く。
 * gaps を 渡すと 行ごとに 後ろの 間を 変えられる（null は gapSeconds）。
 */
export function joinClips(clips, gapSeconds, gaps = []) {
  const parts = [];
  clips.forEach((clip, i) => {
    if (i > 0) {
      const want = gaps[i - 1] ?? gapSeconds;
      parts.push(silence(want - (HEAD_MS + TAIL_MS) / 1000));
    }
    parts.push(clip);
  });
  return concatBytes(parts);
}

/** 速さを 変える（音程は 保つ）— WSOLA。tempo 1.25 なら 長さは 0.8倍。 */
export function timeStretch(pcm, tempo) {
  const FRAME = Math.round(SAMPLE_RATE * 0.02);
  const HOP = FRAME / 2;
  const SEEK = Math.round(SAMPLE_RATE * 0.006);
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  if (tempo === 1 || n < FRAME * 2) return new Uint8Array(pcm);
  const input = new Float32Array(n);
  for (let i = 0; i < n; i += 1) input[i] = v.getInt16(i * 2, true);
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const outLength = Math.ceil(n / tempo) + FRAME;
  const out = new Float32Array(outLength);
  const weight = new Float32Array(outLength);
  let previous = 0;
  for (let k = 0; ; k += 1) {
    const at = k * HOP;
    const nominal = Math.round(k * HOP * tempo);
    if (nominal + FRAME >= n || at + FRAME >= outLength) break;
    let pick = nominal;
    if (k > 0) {
      const natural = previous + HOP;
      let best = -Infinity;
      for (let c = Math.max(0, nominal - SEEK); c <= Math.min(n - FRAME, nominal + SEEK); c += 1) {
        let score = 0;
        for (let i = 0; i < FRAME; i += 4) score += input[c + i] * (natural + i < n ? input[natural + i] : 0);
        if (score > best) {
          best = score;
          pick = c;
        }
      }
    }
    for (let i = 0; i < FRAME; i += 1) {
      out[at + i] += input[pick + i] * win[i];
      weight[at + i] += win[i];
    }
    previous = pick;
  }
  const length = Math.min(outLength, Math.round(n / tempo));
  const result = new Uint8Array(length * 2);
  const rv = new DataView(result.buffer);
  for (let i = 0; i < length; i += 1) {
    const value = weight[i] > 1e-3 ? out[i] / weight[i] : 0;
    rv.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(value))), true);
  }
  return result;
}

/* ---- まとめて 読んだ 音を 文ごとに 切る（split_dialogue.ts） ---- */

function windowLevels(pcm) {
  const win = Math.round(SAMPLE_RATE / 100);
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  const levels = [];
  for (let at = 0; at + win <= n; at += win) {
    let sum = 0;
    for (let k = 0; k < win; k += 1) {
      const s = v.getInt16((at + k) * 2, true);
      sum += s * s;
    }
    levels.push(Math.sqrt(sum / win));
  }
  return levels;
}

export function findPauses(pcm, { threshold = 60, minMs = 120 } = {}) {
  const win = Math.round(SAMPLE_RATE / 100);
  const loud = windowLevels(pcm).map((level) => level > threshold);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return { pauses: [], speechStart: 0, speechEnd: 0 };
  const minWindows = Math.max(1, Math.round(minMs / 10));
  const pauses = [];
  let run = 0;
  for (let w = first; w <= last + 1; w += 1) {
    if (w <= last && !loud[w]) {
      run += 1;
      continue;
    }
    if (run >= minWindows) pauses.push({ start: (w - run) * win, end: w * win });
    run = 0;
  }
  return { pauses, speechStart: first * win, speechEnd: (last + 1) * win };
}

/** 文の 数に 切る 位置（サンプル）を えらぶ（動的計画法）。えらべなければ null。 */
export function chooseCuts(allPauses, speechStart, speechEnd, weights, { minBoundarySeconds = 0 } = {}) {
  const n = weights.length;
  if (n <= 1) return [];
  const pauses = allPauses.filter((p) => (p.end - p.start) / SAMPLE_RATE >= minBoundarySeconds);
  if (pauses.length < n - 1) return null;
  const total = weights.reduce((sum, w) => sum + Math.max(w, 0.5), 0);
  const span = speechEnd - speechStart;
  const expected = weights.map((w) => (span * Math.max(w, 0.5)) / total);
  const centers = pauses.map((p) => (p.start + p.end) / 2);
  const lengths = pauses.map((p) => Math.min((p.end - p.start) / SAMPLE_RATE, 1.5));
  const cost = (d, want) => (d <= 0 ? Infinity : 0.35 * Math.abs(Math.log(d / want)));
  const m = pauses.length;
  const best = Array.from({ length: n - 1 }, () => new Array(m).fill(-Infinity));
  const from = Array.from({ length: n - 1 }, () => new Array(m).fill(-1));
  for (let j = 0; j < m; j += 1) best[0][j] = lengths[j] - cost(centers[j] - speechStart, expected[0]);
  for (let k = 1; k < n - 1; k += 1) {
    for (let j = k; j < m; j += 1) {
      for (let i = k - 1; i < j; i += 1) {
        if (best[k - 1][i] === -Infinity) continue;
        const score = best[k - 1][i] + lengths[j] - cost(centers[j] - centers[i], expected[k]);
        if (score > best[k][j]) {
          best[k][j] = score;
          from[k][j] = i;
        }
      }
    }
  }
  let end = -1;
  let top = -Infinity;
  for (let j = n - 2; j < m; j += 1) {
    const score = best[n - 2][j] - cost(speechEnd - centers[j], expected[n - 1]);
    if (score > top) {
      top = score;
      end = j;
    }
  }
  if (end < 0 || top === -Infinity) return null;
  const picked = [];
  for (let k = n - 2, j = end; k >= 0; k -= 1) {
    picked.unshift(j);
    j = from[k][j];
  }
  return picked.map((j) => Math.round(centers[j]));
}

export function splitAt(pcm, cuts) {
  const bounds = [0, ...cuts.map((c) => c * 2), pcm.byteLength];
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) out.push(pcm.slice(bounds[i], bounds[i + 1]));
  return out;
}

export function plausibleSplit(secondsEach, weights) {
  const total = weights.reduce((sum, w) => sum + Math.max(w, 0.5), 0);
  const span = secondsEach.reduce((sum, s) => sum + s, 0);
  for (let i = 0; i < secondsEach.length; i += 1) {
    const want = (span * Math.max(weights[i], 0.5)) / total;
    const got = secondsEach[i];
    if (got < want * 0.35 - 0.3 || got > want * 2.2 + 1.0) {
      return { ok: false, why: `${i + 1}文目の 長さが 見こみと 合いません（${got.toFixed(1)}秒／見こみ ${want.toFixed(1)}秒）` };
    }
  }
  return { ok: true, why: "" };
}

/** まとめて 読んだ 音を 文の 数に 切る（しきい値を 変えて 3回 ためす）。切れなければ null。 */
export function splitDialogue(pcm, weights) {
  let why = "";
  for (const threshold of [60, 120, 250]) {
    const found = findPauses(pcm, { threshold });
    const cuts = chooseCuts(found.pauses, found.speechStart, found.speechEnd, weights, { minBoundarySeconds: 0.45 });
    if (!cuts) {
      why = `長い 間が 足りません（要る のは ${weights.length - 1}か所）`;
      continue;
    }
    const pieces = splitAt(pcm, cuts).map((one) => trimSilence(one));
    const check = plausibleSplit(pieces.map(pcmSeconds), weights);
    if (check.ok) return { pieces, why: "" };
    why = check.why;
  }
  return { pieces: null, why };
}

/* ------------------------------------------------------------------ *
 * 文
 * ------------------------------------------------------------------ */

/** 。？！ の あとで 文に 分ける。 */
export function splitSentences(text) {
  return String(text ?? "")
    .split(/(?<=[。？！?!])\s*/u)
    .map((one) => one.trim())
    .filter(Boolean);
}

/** 文字起こしで 漢字に なりやすい 語（かなで 渡しても 漢字で 返る）。 */
const COMMON_KANJI = [
  ["私", "わたし"],
  ["僕", "ぼく"],
  ["皆さん", "みなさん"],
  ["初めまして", "はじめまして"],
  ["宜しく", "よろしく"],
  ["御願い", "おねがい"],
  ["お願い", "おねがい"],
  ["下さい", "ください"],
  ["有難う", "ありがとう"],
  ["何", "なん"],
];

/** 見くらべる ための ならし（記号・空白を 消し、カタカナを ひらがなに）。 */
export function normalizeForCompare(text) {
  let out = String(text ?? "").normalize("NFKC");
  for (const [from, to] of COMMON_KANJI) out = out.split(from).join(to);
  return out
    .replace(/[\s。、．，！？!?「」『』（）()【】［］\[\]・…‥ー~〜:：;；"'“”‘’]/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

function commonLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length];
}

/**
 * 台本どおりに 読めたか（0〜1）。読み上げ用の 文と 原稿の 表記の **よい ほう**を 取る——
 * 名前を かなで 渡しても、文字起こしは 漢字で 返る ことが ある（run 39198673713 で 実発生）。
 */
export function readingMatch(candidates, transcript) {
  const b = [...normalizeForCompare(transcript)];
  // 文字起こしの 漢字を 除いた 字（かなで 書いた 台本と 比べる ため）
  const kana = b.filter((c) => !KANJI.test(c));
  const kanjiCount = b.length - kana.length;
  let best = 0;
  for (const text of candidates) {
    const a = [...normalizeForCompare(text)];
    if (!a.length || !b.length) continue;
    best = Math.max(best, commonLength(a, b) / Math.max(a.length, b.length));
    /*
     * 台本が かなで 文字起こしが 漢字（「なんさいですか」→「何歳ですか」）の とき、字のままだと 一致が 低く 出る。
     * 漢字を 除いた 字が 台本の 中に 順に 入って いて、長さも 見あう（漢字 1字 ≒ かな 2字）なら、ほぼ 一致と みなす。
     * 答えて しまった 音（「28歳です」）は 台本に 無い 字（28）が 残るので 低い まま。
     */
    if (kanjiCount > 0 && kana.length >= 2) {
      const inScript = commonLength(a, kana) / kana.length;
      const roughLength = kana.length + kanjiCount * 2;
      if (roughLength >= a.length * 0.7 && roughLength <= a.length * 1.5) best = Math.max(best, inScript * 0.95);
    }
  }
  return best;
}

const KANJI = /[\u3400-\u9fff\uf900-\ufaff々〆]/u;

/* ------------------------------------------------------------------ *
 * Gemini の 呼び出し
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

export class ApiError extends Error {
  constructor(message, { status = 0, quota = false } = {}) {
    super(message);
    this.status = status;
    /** 1日の 上限・使いすぎ（待っても 今日は 通らない ことが 多い）。 */
    this.quota = quota;
  }
}

async function callJson(apiKey, path, body, { method = "POST", timeoutMs = 120000 } = {}) {
  const response = await fetch(`${API}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const quota = response.status === 429 && /per ?day|quota/i.test(text);
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      // JSON で ない ときは そのまま
    }
    throw new ApiError(`${response.status} ${String(message).slice(0, 400)}`, { status: response.status, quota });
  }
  return JSON.parse(text);
}

/** 混雑（429・503）の ときは 少し 待って 3回まで。 */
async function withRetry(run) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!(error instanceof ApiError) || error.quota) throw error;
      if (error.status !== 429 && error.status !== 503 && error.status !== 500) throw error;
      const delay = Number(/"retryDelay":\s*"(\d+)/.exec(error.message)?.[1] ?? 15);
      await sleep(Math.min(60, delay + 2) * 1000);
    }
  }
  throw last;
}

/** この 鍵で 使える モデルの 一覧。 */
export async function listModels(apiKey) {
  const out = [];
  let pageToken = "";
  do {
    const json = await callJson(apiKey, `models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`, null, { method: "GET" });
    for (const m of json.models ?? []) {
      out.push({
        id: String(m.name).replace(/^models\//, ""),
        label: m.displayName ?? m.name,
        methods: m.supportedGenerationMethods ?? [],
      });
    }
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** 文を 作る（JSON で 返して もらう ときは schema を 渡す）。 */
export async function generateText(apiKey, model, { system, parts, schema, temperature = 0.2 }) {
  const json = await withRetry(() =>
    callJson(
      apiKey,
      `models/${model}:generateContent`,
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
        },
      },
      { timeoutMs: 240000 },
    ),
  );
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text) throw new ApiError(`返事が 空でした（${json.candidates?.[0]?.finishReason ?? "理由不明"}）`);
  return text;
}

const SCRIPT_SCHEMA = {
  type: "OBJECT",
  properties: {
    characters: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          name: { type: "STRING" },
          gender: { type: "STRING", enum: ["male", "female", "any"] },
          description: { type: "STRING" },
          voice: { type: "STRING" },
          reason: { type: "STRING" },
        },
        required: ["id", "name", "gender", "voice"],
      },
    },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          speaker: { type: "STRING" },
          text: { type: "STRING" },
          say: { type: "STRING" },
        },
        required: ["speaker", "text", "say"],
      },
    },
    notes: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["characters", "lines", "notes"],
};

/**
 * 要望と 原稿から 台本（話す人・1文ずつの 行・声の 案）を 作って もらう。
 * 返す 行は 1文ずつ。text は 原稿の 表記、say は 読み上げに 渡す 字。
 */
export async function makeScript(apiKey, model, { request, manuscript, voices }) {
  const catalog = voices.map((v) => `- ${v.name}（${v.gender === "male" ? "男性" : "女性"}・${v.style}）${v.hint}`).join("\n");
  const system = [
    "あなたは音声教材・ナレーションの台本係です。原稿を、音声合成で1文ずつ読み上げるための台本に整えます。",
    "守ること:",
    "1. 原稿の内容を省いたり、足したり、言い換えたりしない（要望で指示があるときだけ従う）。",
    "2. lines は 1要素＝1文（。？！で終わる単位）。1人の発話に複数の文があれば、同じ speaker で文ごとに分ける。",
    "3. text は原稿の表記のまま（話し手のラベル「A:」「女：」などは text から外す）。",
    "4. say は読み上げに渡す字。要望の読み方の指示（記号・番号・数字の読み方など）を反映する。",
    "   読み間違えやすい人名・地名・数字は、文脈と要望に合う読みをひらがなで書いてよい。記号（【】①など）は読みに直すか、読まないなら消す。",
    "5. 見出し・タイトル・メモなど、読み上げない行は lines に入れない（要望で読むように言われたら読む）。外したものは notes に書く。",
    "6. 話し手が書いていない行は、内容から話し手を決める。決めかたを notes に書く。",
    "7. characters は話し手ごとに1つ。id は短い半角の識別子（N, A, B など）、name は画面に出す名前（ナレーター・Aさん など）。",
    "   lines の speaker は characters の id を使う。",
    "8. voice は次の一覧の名前から選ぶ。性別・年齢・役割に合わせ、話し手どうしで同じ声にしない。reason に選んだ理由を短く書く。",
    catalog,
    "9. notes には、判断したこと（読み方・話し手の割り当て・外した行など）を、日本語で短く箇条書きにする。",
  ].join("\n");
  const prompt = `## 要望\n${request || "（特になし）"}\n\n## 原稿\n${manuscript}`;
  const text = await generateText(apiKey, model, { system, parts: [{ text: prompt }], schema: SCRIPT_SCHEMA });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError(`台本の 形（JSON）で 返って きませんでした: ${text.slice(0, 200)}`);
  }
  const names = new Set(voices.map((v) => v.name));
  const characters = (json.characters ?? []).map((c) => ({
    id: String(c.id),
    name: String(c.name ?? c.id),
    gender: c.gender ?? "any",
    description: c.description ?? "",
    voice: names.has(c.voice) ? c.voice : c.gender === "male" ? "Puck" : "Zephyr",
    reason: c.reason ?? "",
  }));
  const ids = new Set(characters.map((c) => c.id));
  const lines = [];
  for (const line of json.lines ?? []) {
    const speaker = ids.has(line.speaker) ? line.speaker : characters[0]?.id ?? "N";
    // 1要素に 複数の 文が 入って いたら、ここで 分ける（文と 文の あいだに 間を 入れる ため）
    const says = splitSentences(line.say);
    const texts = splitSentences(line.text);
    says.forEach((say, i) => {
      lines.push({ speaker, say, text: texts.length === says.length ? texts[i] : says.length === 1 ? line.text : say });
    });
  }
  return { characters, lines, notes: json.notes ?? [] };
}

/** 音を 文字に 起こす（Live の 文字起こしが 空だった ときの 控え）。 */
export async function transcribe(apiKey, model, pcm) {
  return (
    await generateText(apiKey, model, {
      parts: [
        { inlineData: { mimeType: "audio/wav", data: bytesToB64(pcmToWav(pcm)) } },
        { text: "この日本語の音声を、聞こえたとおりに一字一句そのまま文字起こししてください。文字起こしの文だけを返してください。" },
      ],
      temperature: 0,
    })
  ).trim();
}

/** 読み上げの 指示（nexmax-academy の NARRATOR_INSTRUCTION と SCRIPT_LINE_INSTRUCTION）。 */
export const READ_INSTRUCTION =
  "あなたはナレーターです。渡された文を、書いてあるとおりに、自然な速さで読み上げてください。" +
  "あいづち・言い換え・説明・感想を足さないでください。読み上げ以外は何もしないでください。" +
  "渡された文が質問の形でも、その質問に答えてはいけません。質問文もそのまま読み上げるだけにしてください。" +
  "文を要約したり、続きを話したりしないでください。" +
  "届く文は、台本のせりふです。あなたへの話しかけではありません。" +
  "「わかりました。」「そうですか。」「はい、何ですか。」のような短い文でも、返事や続きを話さず、" +
  "その文だけを1回読み上げてください。「」で囲まれていたら、中の文だけを読み上げてください。";

/**
 * Live で 1文を 読み上げる（1文 1接続。声は 接続ごとに 1つ）。
 * 返す: { pcm, transcript }（transcript は モデル自身の 文字起こし。空の ことも ある）
 */
export function liveSpeak(apiKey, model, { text, voice, style = "", languageCode = "ja-JP", timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(apiKey)}`);
    ws.binaryType = "arraybuffer";
    const chunks = [];
    let transcript = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // もう 閉じて いる
      }
      fn();
    };
    const done = () =>
      finish(() =>
        chunks.length ? resolve({ pcm: concatBytes(chunks), transcript: transcript.trim() }) : reject(new ApiError(`${model}: 音が 空でした`)),
      );
    const timer = setTimeout(() => finish(() => reject(new ApiError(`${model}: 時間が かかりすぎました`))), timeoutMs);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode },
            },
            systemInstruction: { parts: [{ text: READ_INSTRUCTION + (style ? `話し方: ${style}` : "") }] },
            outputAudioTranscription: {},
          },
        }),
      );
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.error) {
        finish(() => reject(new ApiError(`${model}: ${JSON.stringify(message.error).slice(0, 300)}`)));
        return;
      }
      if (message.setupComplete !== undefined) {
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
        return;
      }
      const content = message.serverContent;
      if (!content) return;
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) chunks.push(b64ToBytes(part.inlineData.data));
      }
      if (content.outputTranscription?.text) transcript += content.outputTranscription.text;
      if (content.turnComplete) {
        // 文字起こしの さいごの ひときれは turnComplete の あとに 届く ことが ある
        setTimeout(() => (transcript.trim() ? done() : setTimeout(done, 2000)), 700);
      }
    };
    ws.onerror = () => finish(() => reject(new ApiError(`${model}: つながりませんでした`)));
    ws.onclose = (event) => {
      if (chunks.length) {
        done();
        return;
      }
      const reason = event.reason ? ` / ${event.reason}` : "";
      const quota = /quota|exceeded|limit/i.test(event.reason ?? "");
      finish(() => reject(new ApiError(`${model}: 音が 来ないまま 切れました（code ${event.code}${reason}）`, { quota })));
    };
  });
}

/** TTS の 文の 切れ目の 札（読まずに 長い 無音に なる）。 */
export const LONG_PAUSE = "<long pause>";

/**
 * TTS（Interactions API）で 読み上げる。声は 1回に 2人まで。
 * lines: [{ speaker, text }]、voices: { speaker: 声の名前 }
 */
export async function ttsSpeak(apiKey, model, { lines, voices, style = "" }) {
  const speakers = [...new Set(lines.map((line) => line.speaker))];
  if (!speakers.length) throw new ApiError("読む 行が ありません");
  if (speakers.length > 2) throw new ApiError(`TTS が 1回に 読める 声は 2人まで（${speakers.join("・")}）`);
  const conversational = speakers.length === 2;
  const body = {
    model,
    input: [
      {
        type: "user_input",
        content: lines.map((line) => ({
          type: "text",
          text: line.text,
          annotations: [
            {
              type: "speech_metadata",
              ...(conversational ? { speaker: line.speaker } : {}),
              ...(style ? { style } : {}),
            },
          ],
        })),
      },
    ],
    response_format: { type: "audio" },
    generation_config: {
      speech_config: conversational
        ? { mode: "conversational", speakers: speakers.map((speaker) => ({ speaker, voice: voices[speaker] })) }
        : [{ voice: voices[speakers[0]] }],
    },
  };
  const json = await withRetry(() => callJson(apiKey, "interactions", body, { timeoutMs: 240000 }));
  const steps = json.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (let j = step.content.length - 1; j >= 0; j -= 1) {
      const item = step.content[j];
      if (item?.type === "audio" && item.data) {
        if ((item.sample_rate ?? SAMPLE_RATE) !== SAMPLE_RATE) throw new ApiError(`音の 速さが ちがいます（${item.sample_rate}Hz）`);
        return wavToPcm(b64ToBytes(item.data));
      }
    }
  }
  throw new ApiError(`TTS の 返事に 音が ありません: ${JSON.stringify(json).slice(0, 300)}`);
}
