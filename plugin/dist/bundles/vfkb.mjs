#!/usr/bin/env node

// src/engine.ts
import { randomBytes } from "node:crypto";

// src/storage.ts
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
function isTombstone(r) {
  return r.deleted === true;
}
function brainDir() {
  return process.env.VFKB_DATA_DIR || process.env.VFKB_DIR || join(homedir(), ".vfkb");
}
function defaultProject() {
  if (process.env.VFKB_PROJECT) return process.env.VFKB_PROJECT;
  const explicit = process.env.VFKB_DATA_DIR || process.env.VFKB_DIR;
  if (explicit) {
    const abs = resolve(explicit);
    const name = basename(abs);
    return name.startsWith(".") ? basename(dirname(abs)) || "spike" : name;
  }
  const root = process.env.CLAUDE_PROJECT_DIR;
  if (root) return basename(resolve(root)) || "spike";
  return basename(process.cwd()) || "spike";
}
function recordsFile() {
  return join(brainDir(), "entries.jsonl");
}
function metaFile() {
  return join(brainDir(), "index-meta.json");
}
function appendRecord(rec) {
  mkdirSync(brainDir(), { recursive: true });
  appendFileSync(recordsFile(), JSON.stringify(rec) + "\n", "utf8");
  writeMeta();
}
function contextSpinePath() {
  return join(brainDir(), "context.md");
}
function readContextSpine() {
  const p = contextSpinePath();
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}
function writeContextSpine(content) {
  mkdirSync(brainDir(), { recursive: true });
  writeFileSync(contextSpinePath(), content);
}
function readRecords() {
  const f = recordsFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}
function materialize(records = readRecords()) {
  const newest = /* @__PURE__ */ new Map();
  for (const r of records) {
    const cur = newest.get(r.id);
    if (!cur || r.updated >= cur.updated) newest.set(r.id, r);
  }
  const out = [];
  for (const r of newest.values())
    if (!isTombstone(r)) out.push(r.tags ? r : { ...r, tags: [] });
  return out;
}
function contentHash(entries = materialize()) {
  const basis = entries.map((e) => `${e.id}@${e.updated}`).sort().join("\n");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
function readMeta() {
  const f = metaFile();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function writeMeta() {
  const entries = materialize();
  const meta = {
    content_hash: contentHash(entries),
    entry_count: entries.length,
    last_write: (/* @__PURE__ */ new Date()).toISOString()
  };
  mkdirSync(brainDir(), { recursive: true });
  writeFileSync(metaFile(), JSON.stringify(meta), "utf8");
  return meta;
}

// src/index-store.ts
function stem(t) {
  for (const suf of ["ing", "ed", "ly", "es", "s"]) {
    if (t.length - suf.length >= 3 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}
function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1).map(stem);
}
function queryTermCount(query) {
  return new Set(tokenize(query)).size;
}
var InMemoryIndex = class {
  entries = [];
  token = "";
  constructor() {
    this.rebuild();
  }
  rebuild() {
    this.entries = materialize(readRecords());
    this.token = contentHash(this.entries);
  }
  // Rebuild iff the persisted content token differs from what we hold.
  // The meta hash is authoritative when present; else recompute from JSONL
  // (covers a git pull that changed entries.jsonl but not the sidecar).
  ensureFresh() {
    const persisted = readMeta()?.content_hash ?? contentHash();
    if (persisted !== this.token) this.rebuild();
  }
  all() {
    this.ensureFresh();
    return this.entries;
  }
  get(id) {
    this.ensureFresh();
    return this.entries.find((e) => e.id === id);
  }
  // Stage-1 relevance: stemmed term-overlap count over text + tags — NOT BM25
  // (no IDF, no length normalization; the score is # of entry tokens matching a
  // query term). Adequate as a candidate signal at per-project scale; semantic
  // ranking is the deferred EmbeddingReranker (ADR-0012/0016). The envelope-aware
  // Heuristic reranker is a separate Stage-2 applied to these candidates.
  searchScored(query, k = 30) {
    this.ensureFresh();
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];
    return this.entries.map((entry) => {
      const hay = tokenize(entry.text + " " + (entry.tags ?? []).join(" "));
      let score = 0;
      const hit = /* @__PURE__ */ new Set();
      for (const t of hay)
        if (terms.has(t)) {
          score++;
          hit.add(t);
        }
      return { entry, score, matched: hit.size };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.entry.updated.localeCompare(a.entry.updated)).slice(0, k);
  }
  search(query, k = 30) {
    return this.searchScored(query, k).map((x) => x.entry);
  }
  freshnessToken() {
    return this.token;
  }
};
function selectIndex() {
  return new InMemoryIndex();
}

// src/secrets.ts
var PATTERNS = [
  { kind: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "gcp-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // Azure storage account key (the base64 value in a connection string / SAS) — the
  // highest-likelihood secret for this Azure-ops substrate. AccountKey isn't an
  // api[_-]?key, so the generic assigned-secret rule below misses it.
  { kind: "azure-storage-key", re: /\bAccountKey=[A-Za-z0-9+/]{30,}={0,2}/ },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/\-]{20,}=*\b/ },
  {
    kind: "assigned-secret",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}/i
  }
];
function detectSecrets(text) {
  const hits = [];
  for (const p of PATTERNS) if (p.re.test(text)) hits.push({ kind: p.kind });
  return hits;
}
function assertNoSecrets(text) {
  const hits = detectSecrets(text);
  if (hits.length > 0) {
    throw new Error(
      `refusing to store: looks like a secret (${hits.map((h) => h.kind).join(", ")}). The brain is git-committed \u2014 keep secrets out (D6e).`
    );
  }
}

// src/counters.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
function signalsFile() {
  return join2(brainDir(), ".signals", "counters.jsonl");
}
function recordSignal(entryId, kind, source) {
  const sig = { entryId, kind, at: (/* @__PURE__ */ new Date()).toISOString(), source };
  mkdirSync2(join2(brainDir(), ".signals"), { recursive: true });
  appendFileSync2(signalsFile(), JSON.stringify(sig) + "\n", "utf8");
  return sig;
}
function readSignals() {
  const f = signalsFile();
  if (!existsSync2(f)) return [];
  return readFileSync2(f, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}
function tally(entryId, signals = readSignals()) {
  let helpful = 0;
  let harmful = 0;
  for (const s of signals) {
    if (s.entryId !== entryId) continue;
    if (s.kind === "helpful") helpful++;
    else if (s.kind === "harmful") harmful++;
  }
  return { helpful, harmful, net: helpful - harmful };
}

// src/session.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2, existsSync as existsSync3, readdirSync } from "node:fs";
import { join as join3 } from "node:path";
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var SessionState = class _SessionState {
  data;
  injected = /* @__PURE__ */ new Set();
  captured = /* @__PURE__ */ new Set();
  file;
  sessionId;
  constructor(file, sessionId) {
    this.file = file;
    this.sessionId = sessionId;
    const ts = now();
    this.data = {
      sessionId,
      startedAt: ts,
      lastAt: ts,
      turnCount: 0,
      injectedIds: [],
      capturedIds: []
    };
    if (file && existsSync3(file)) {
      try {
        const loaded = JSON.parse(readFileSync3(file, "utf8"));
        this.data = {
          sessionId,
          startedAt: loaded.startedAt ?? ts,
          lastAt: loaded.lastAt ?? ts,
          turnCount: loaded.turnCount ?? 0,
          injectedIds: loaded.injectedIds ?? [],
          capturedIds: loaded.capturedIds ?? [],
          note: loaded.note,
          signals: loaded.signals
        };
        this.injected = new Set(this.data.injectedIds);
        this.captured = new Set(this.data.capturedIds);
      } catch {
      }
    }
  }
  static load(sessionId = process.env.KB_SESSION_ID) {
    if (!sessionId) return new _SessionState(null);
    const dir = join3(brainDir(), ".sessions");
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    return new _SessionState(join3(dir, `${safe}.json`), sessionId);
  }
  // The append-only record log: every persisted session record, newest-first by lastAt.
  static records() {
    const dir = join3(brainDir(), ".sessions");
    if (!existsSync3(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync3(join3(dir, f), "utf8")));
      } catch {
      }
    }
    return out.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  }
  isInjected(id) {
    return this.injected.has(id);
  }
  markInjected(ids) {
    for (const id of ids) this.injected.add(id);
  }
  recordCaptured(id) {
    this.captured.add(id);
  }
  get capturedIds() {
    return [...this.captured];
  }
  setNote(text) {
    this.data.note = text;
  }
  addSignal(label, value) {
    (this.data.signals ??= []).push({ label, value });
  }
  bumpTurn() {
    this.data.turnCount++;
  }
  get turnCount() {
    return this.data.turnCount;
  }
  get startedAt() {
    return this.data.startedAt;
  }
  save() {
    if (!this.file) return;
    this.data.sessionId = this.sessionId;
    this.data.lastAt = now();
    this.data.injectedIds = [...this.injected];
    this.data.capturedIds = [...this.captured];
    const dir = join3(brainDir(), ".sessions");
    mkdirSync3(dir, { recursive: true });
    writeFileSync2(this.file, JSON.stringify(this.data), "utf8");
  }
};

// src/engine.ts
var SESSION_BUDGET_CHARS = 1e4;
var FLUID_TYPES = /* @__PURE__ */ new Set(["fact", "gotcha", "pattern", "link"]);
var DECISION_FAMILY = /* @__PURE__ */ new Set(["decision"]);
function isDecisionFamily(type) {
  return DECISION_FAMILY.has(type);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId() {
  return randomBytes(6).toString("hex");
}
function deriveTrust(role) {
  if (role === "human") return "operator";
  if (role === "init" || role === "import") return "import";
  return "agent";
}
function foldWhy(text, why) {
  const w = (why ?? "").trim();
  if (!w) return text;
  if (/(^|\n)\s*why:/i.test(text)) return text;
  return `${text}

Why: ${w}`;
}
function addEntry(type, text, opts = {}) {
  text = foldWhy(text, opts.why);
  assertNoSecrets(text);
  const role = opts.role ?? "executor";
  const ts = nowIso();
  const entry = {
    id: newId(),
    type,
    text,
    tags: opts.tags ?? [],
    zone: opts.zone ?? (deriveTrust(role) === "operator" ? "established" : "incoming"),
    author: { role },
    refs: opts.supersedes ? { supersedes: opts.supersedes } : void 0,
    provenance: {
      status: opts.provStatus ?? (deriveTrust(role) === "operator" ? "verified" : "unverified"),
      date: ts,
      origin: opts.origin
    },
    validity: { valid_from: ts, valid_until: opts.validUntil },
    // default a brand-new decision to `proposed` (an RFC, ADR-0007) unless told.
    status: opts.status ?? (isDecisionFamily(type) ? "proposed" : void 0),
    constitutional: isDecisionFamily(type) ? opts.constitutional : void 0,
    created: ts,
    updated: ts
  };
  appendRecord(entry);
  return entry;
}
function readAll() {
  return materialize();
}
function updateEntry(id, patch) {
  const cur = readAll().find((e) => e.id === id);
  if (!cur) throw new Error(`no such entry: ${id}`);
  if (!FLUID_TYPES.has(cur.type)) {
    throw new Error(
      `entry ${id} is a ${cur.type} (decision family) \u2014 immutable; supersede it, don't edit (ADR-0004)`
    );
  }
  const next = { ...cur, ...patch, updated: nowIso() };
  appendRecord(next);
  return next;
}
function setProvenanceStatus(id, status) {
  const cur = readAll().find((e) => e.id === id);
  if (!cur) throw new Error(`no such entry: ${id}`);
  const next = {
    ...cur,
    provenance: { ...cur.provenance, status },
    updated: nowIso()
  };
  appendRecord(next);
  return next;
}
function buildContextMap() {
  const all = readAll();
  const superseded = supersededIds(all);
  const byType = { fact: 0, decision: 0, gotcha: 0, pattern: 0, link: 0 };
  const byZone = { incoming: 0, established: 0, archive: 0 };
  const decisions = { accepted: 0, proposed: 0, superseded: 0, deprecated: 0, constitutional: 0 };
  const tagCounts = /* @__PURE__ */ new Map();
  for (const e of all) {
    byType[e.type]++;
    byZone[e.zone]++;
    for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    if (isDecisionFamily(e.type)) {
      const eff = effectiveStatus(e, superseded);
      if (eff === "accepted") decisions.accepted++;
      else if (eff === "proposed") decisions.proposed++;
      else if (eff === "superseded") decisions.superseded++;
      else if (eff === "deprecated") decisions.deprecated++;
      if (e.constitutional && eff === "accepted") decisions.constitutional++;
    }
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([tag, n]) => ({ tag, n }));
  return { total: all.length, byType, byZone, decisions, topTags };
}
function renderContextMap(map = buildContextMap()) {
  const types = Object.entries(map.byType).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(" \xB7 ");
  const d = map.decisions;
  const decLine = `decisions: ${d.accepted} accepted (${d.constitutional} constitutional)` + (d.proposed ? ` \xB7 ${d.proposed} proposed` : "") + (d.superseded ? ` \xB7 ${d.superseded} superseded` : "") + (d.deprecated ? ` \xB7 ${d.deprecated} deprecated` : "");
  const tags = map.topTags.length ? map.topTags.map((t) => `${t.tag}(${t.n})`).join(" ") : "(none)";
  return `<vfkb-map>
${map.total} entries \xB7 ${types} \xB7 zones: established ${map.byZone.established}/incoming ${map.byZone.incoming}
${decLine}
top tags: ${tags}
pull more: search <terms> \xB7 filter by type/tag/status/author
</vfkb-map>`;
}
function supersede(oldId, text, opts = {}) {
  const old = readAll().find((e) => e.id === oldId);
  if (!old) throw new Error(`no such entry: ${oldId}`);
  if (!isDecisionFamily(old.type)) {
    throw new Error(`entry ${oldId} is not a decision \u2014 fluid types are edited, not superseded`);
  }
  return addEntry("decision", text, {
    role: opts.role ?? "human",
    why: opts.why,
    tags: opts.tags,
    status: opts.status ?? "accepted",
    constitutional: opts.constitutional ?? old.constitutional,
    supersedes: oldId
  });
}
function transitionDecision(id, status) {
  if (status === "superseded") {
    throw new Error("`superseded` is derived from a supersession edge \u2014 use supersede()");
  }
  const cur = readAll().find((e) => e.id === id);
  if (!cur) throw new Error(`no such entry: ${id}`);
  if (!isDecisionFamily(cur.type)) {
    throw new Error(`entry ${id} is not a decision \u2014 use updateEntry() for fluid types`);
  }
  const next = { ...cur, status, updated: nowIso() };
  appendRecord(next);
  return next;
}
function supersededIds(entries = readAll()) {
  const s = /* @__PURE__ */ new Set();
  for (const e of entries) if (e.refs?.supersedes) s.add(e.refs.supersedes);
  return s;
}
function effectiveStatus(e, superseded = supersededIds()) {
  if (superseded.has(e.id)) return "superseded";
  return e.status;
}
function deriveConstitution() {
  const live = readAll();
  const superseded = supersededIds(live);
  return live.filter(
    (e) => isDecisionFamily(e.type) && e.constitutional === true && effectiveStatus(e, superseded) === "accepted"
  ).sort((a, b) => (a.adr_no ?? 1e9) - (b.adr_no ?? 1e9));
}
function isInjectable(e, today = nowIso().slice(0, 10), superseded) {
  if (e.zone === "archive") return false;
  if (superseded?.has(e.id)) return false;
  if (e.status === "deprecated" || e.status === "superseded") return false;
  if (e.provenance.status === "stale" || e.provenance.status === "expired") return false;
  if (e.validity.valid_until && e.validity.valid_until.slice(0, 10) < today) return false;
  return true;
}
var TYPE_WEIGHT = {
  pattern: 5,
  // patterns + gotchas first (L3 tiered render)
  gotcha: 5,
  decision: 4,
  fact: 2,
  link: 1
};
function withinTierScore(e) {
  let s = 0;
  if (deriveTrust(e.author.role) === "operator") s += 3;
  if (e.provenance.status === "verified") s += 1;
  return s;
}
function heuristicCompare(a, b) {
  const tier = TYPE_WEIGHT[b.type] - TYPE_WEIGHT[a.type];
  if (tier !== 0) return tier;
  const within = withinTierScore(b) - withinTierScore(a);
  if (within !== 0) return within;
  return b.updated.localeCompare(a.updated);
}
function rerank(entries) {
  return [...entries].sort(heuristicCompare);
}
function trustGlyph(e) {
  const t = deriveTrust(e.author.role);
  const v = e.provenance.status === "verified" ? "\u2713" : e.provenance.status === "unverified" ? "\u26A0" : "";
  return `${v}${t}`;
}
function renderContextBundle(project = defaultProject(), budget = SESSION_BUDGET_CHARS) {
  const all = readAll();
  const today = nowIso().slice(0, 10);
  const superseded = supersededIds(all);
  const injectable = rerank(all.filter((e) => isInjectable(e, today, superseded)));
  const header = `<vfkb-context project="${project}">
`;
  const footer = `
</vfkb-context>`;
  let body = "";
  const constitution = deriveConstitution();
  if (constitution.length > 0) {
    body += "## Constitution (always applies)\n";
    for (const c of constitution) {
      const n = typeof c.adr_no === "number" ? `ADR-${String(c.adr_no).padStart(4, "0")} ` : "";
      body += `- [${n}constitutional] ${c.text}
`;
    }
    body += "\n";
  }
  const constitutionalIds = new Set(constitution.map((c) => c.id));
  body += renderContextMap() + "\n\n";
  let dropped = 0;
  for (const e of injectable) {
    if (constitutionalIds.has(e.id)) continue;
    const line = `- [${e.type} ${trustGlyph(e)}] ${e.text}
`;
    if (header.length + body.length + line.length + footer.length > budget) {
      dropped++;
      continue;
    }
    body += line;
  }
  if (dropped > 0) {
    const note = `<!-- ${dropped} lower-ranked entries omitted for the ${budget}-char budget -->
`;
    if (header.length + body.length + note.length + footer.length <= budget) body += note;
  }
  return header + body + footer;
}
var CONTEXT_SPINE_SCAFFOLD = `# Project Context

## Job-to-be-done
<what this project is \u2014 the job it does for its users>

## Architecture
<the shape of the system: key components and how they fit>

## Tech profile
<languages, frameworks, runtimes, datastores>

## Conventions
<load-bearing conventions an agent must follow>

## Vision / Taste
<the taste/voice this project holds to (ADR-0010)>
`;
function initContextSpine() {
  const p = contextSpinePath();
  if (readContextSpine() !== null) return { created: false, path: p };
  writeContextSpine(CONTEXT_SPINE_SCAFFOLD);
  return { created: true, path: p };
}
function renderContext(project = defaultProject()) {
  const all = readAll();
  const sup = supersededIds(all);
  const out = [`# ${project} \u2014 project context`, ""];
  const spine = readContextSpine();
  if (spine) {
    out.push("<!-- authored spine (architect-maintained) -->", spine, "");
  } else {
    out.push(
      "_(no authored context spine yet \u2014 run `vfkb context init` to scaffold `context.md`. The derived sections below are always current.)_",
      ""
    );
  }
  const constitution = deriveConstitution();
  if (constitution.length > 0) {
    out.push("## Constitution (derived \u2014 always applies)");
    for (const c of constitution) {
      const n = typeof c.adr_no === "number" ? `ADR-${String(c.adr_no).padStart(4, "0")} ` : "";
      out.push(`- [${n}constitutional] ${c.text}`);
    }
    out.push("");
  }
  out.push("## Map (derived)", renderContextMap(), "");
  const decisions = all.filter(
    (e) => e.type === "decision" && !e.constitutional && effectiveStatus(e, sup) === "accepted"
  );
  if (decisions.length > 0) {
    out.push("## Load-bearing decisions (derived)");
    for (const d of decisions) {
      const n = typeof d.adr_no === "number" ? `ADR-${String(d.adr_no).padStart(4, "0")} ` : "";
      out.push(`- [${n}decision] ${d.text}`);
    }
    out.push("");
  }
  const links = all.filter((e) => e.type === "link" && isInjectable(e, void 0, sup));
  if (links.length > 0) {
    out.push("## Links & docs (derived)");
    for (const l of links) out.push(`- ${l.text}`);
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}
function renderNaiveDump(project = defaultProject(), budget = SESSION_BUDGET_CHARS, limit) {
  let entries = readAll().filter((e) => e.zone !== "archive").sort((a, b) => a.created.localeCompare(b.created));
  if (typeof limit === "number") entries = entries.slice(0, limit);
  const header = `<context project="${project}">
`;
  const footer = `
</context>`;
  let body = "";
  for (const e of entries) {
    const line = `- ${e.text}
`;
    if (header.length + body.length + line.length + footer.length > budget) break;
    body += line;
  }
  return header + body + footer;
}
function isOwnKnowledgeTool(name) {
  const n = name.toLowerCase();
  return n.startsWith("kb_") || n.includes("vfkb");
}
var RESULT_SUMMARY_CAP = 120;
function classifyToolOutcome(result) {
  if (result === void 0 || result === null) return { outcome: "ok", summary: "" };
  if (typeof result === "object") {
    const r = result;
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : void 0;
    const isErr2 = r.isError === true || r.error != null || typeof r.stderr === "string" && r.stderr.trim() !== "" || exit !== void 0 && exit !== 0;
    const basis = r.error ?? r.stderr ?? r.message ?? r.result ?? r;
    const summary = (typeof basis === "string" ? basis : JSON.stringify(basis)).slice(0, RESULT_SUMMARY_CAP);
    return { outcome: isErr2 ? "error" : "ok", summary };
  }
  const s = String(result).slice(0, RESULT_SUMMARY_CAP);
  const isErr = /(^|\s)(error|failed|failure|exception|denied|traceback|refused)\b/i.test(s);
  return { outcome: isErr ? "error" : "ok", summary: s };
}
function captureToolCall(ev) {
  if (!ev.tool_name) return null;
  if (isOwnKnowledgeTool(ev.tool_name)) return null;
  const inputSummary = typeof ev.tool_input === "object" && ev.tool_input ? JSON.stringify(ev.tool_input).slice(0, 200) : String(ev.tool_input ?? "");
  const { outcome, summary } = classifyToolOutcome(ev.tool_result);
  const text = `Tool ${ev.tool_name} invoked${inputSummary ? `: ${inputSummary}` : ""}` + (summary ? ` \u2192 ${outcome}: ${summary}` : "");
  try {
    return addEntry("fact", text, {
      role: "executor",
      tags: ["captured", `capture:${outcome}`],
      provStatus: "unverified",
      origin: { kind: "tool_call", tool: ev.tool_name, call_id: ev.call_id }
    });
  } catch {
    return null;
  }
}
function sessionWindow(all, from, to) {
  const added = all.filter((e) => e.created >= from && e.created <= to);
  const superseded = added.filter((e) => e.refs?.supersedes);
  return { added, superseded };
}
var DIGEST_LESSON_CAP = 5;
function distilledLessons(added) {
  return added.filter((e) => e.zone === "incoming" && e.tags.includes("distilled")).sort((a, b) => b.created.localeCompare(a.created));
}
function renderResumeDigest(rec, all = readAll()) {
  const { added, superseded } = sessionWindow(all, rec.startedAt, rec.lastAt);
  const when = (rec.lastAt ?? "").slice(0, 16).replace("T", " ");
  const lines = [
    `## Resume \u2014 last recorded session (${when}Z)`,
    `- observed (re-derived from the brain): ${added.length} entries added, ${superseded.length} superseded, ${rec.injectedIds?.length ?? 0} injected, ${rec.capturedIds?.length ?? 0} captured, ${rec.turnCount ?? 0} turns`
  ];
  const lessons = distilledLessons(added);
  if (lessons.length > 0) {
    lines.push(`- learned (auto-distilled this session \u2014 candidates, verify before trusting):`);
    for (const e of lessons.slice(0, DIGEST_LESSON_CAP)) {
      const net = tally(e.id).net;
      const corr = net > 0 ? ` (+${net} corroborating)` : "";
      lines.push(`  - [${e.type} ${trustGlyph(e)}] ${e.text}${corr}`);
    }
    if (lessons.length > DIGEST_LESSON_CAP) {
      lines.push(`  - \u2026and ${lessons.length - DIGEST_LESSON_CAP} more (search tag:distilled)`);
    }
  }
  if (rec.note) lines.push(`- next (ASSERTED by operator, unverified): ${rec.note}`);
  for (const s of rec.signals ?? []) lines.push(`- ${s.label} (ASSERTED by caller): ${s.value}`);
  return lines.join("\n");
}
function renderResume(project = defaultProject(), session = SessionState.load()) {
  const all = readAll();
  const prior = SessionState.records().find((r) => r.sessionId !== session.sessionId);
  const digest = prior ? renderResumeDigest(prior, all) : "## Resume\n- (first recorded session \u2014 no prior continuity)";
  const head = `<vfkb-resume project="${project}">
${digest}
</vfkb-resume>`;
  const bundle = renderContextBundle(project, Math.max(0, SESSION_BUDGET_CHARS - head.length - 1));
  return `${head}
${bundle}`;
}

// src/curator.ts
function get(id) {
  const e = readAll().find((x) => x.id === id);
  if (!e) throw new Error(`no such entry: ${id}`);
  return e;
}
function promote(id) {
  const e = get(id);
  if (isDecisionFamily(e.type)) {
    throw new Error(`promote() is for fluid types; a decision's standing is its status (use transitionDecision)`);
  }
  return updateEntry(id, { zone: "established" });
}
var PROMOTION_THRESHOLD = 2;
function eligibleForPromotion(id, threshold = PROMOTION_THRESHOLD) {
  return tally(id).net >= threshold;
}
function promoteIfCorroborated(id, threshold = PROMOTION_THRESHOLD) {
  const t = tally(id);
  if (t.net < threshold) {
    throw new Error(
      `entry ${id} is not corroborated (net ${t.net} < ${threshold}) \u2014 auto-distill alone cannot mint trusted knowledge (ADR-0021); needs more signals or a human promote`
    );
  }
  promote(id);
  return setProvenanceStatus(id, "verified");
}
function archive(id) {
  const e = get(id);
  if (isDecisionFamily(e.type)) return transitionDecision(id, "deprecated");
  return updateEntry(id, { zone: "archive" });
}
function mergeDuplicate(loserId, winnerId) {
  const loser = get(loserId);
  get(winnerId);
  if (isDecisionFamily(loser.type)) {
    throw new Error(`merge a decision via supersede(), not the curator`);
  }
  const tags = [.../* @__PURE__ */ new Set([...loser.tags, `merged-into:${winnerId}`])];
  return updateEntry(loserId, { zone: "archive", tags });
}
function findLexicalDuplicates(entries = readAll()) {
  const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const seen = /* @__PURE__ */ new Map();
  const out = [];
  for (const e of entries) {
    if (e.zone === "archive" || isDecisionFamily(e.type)) continue;
    const key = `${e.type}:${norm(e.text)}`;
    const winner = seen.get(key);
    if (winner) out.push({ loser: e.id, winner });
    else seen.set(key, e.id);
  }
  return out;
}

// src/distiller.ts
import { createHash as createHash2 } from "node:crypto";
var SIG_PREFIX = "distill-sig:";
var DISTILLED_TAG = "distilled";
function errorClass(summary) {
  return summary.toLowerCase().replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b/g, "#").replace(/\b\d+\b/g, "#").replace(/[\/\\][^\s'"]+/g, "/path").replace(/\s+/g, " ").trim().slice(0, 80);
}
function toolOf(e) {
  return e.provenance.origin?.kind === "tool_call" ? e.provenance.origin.tool : "unknown";
}
function summaryOf(e) {
  const m = e.text.match(/→ error:\s*(.*)$/);
  return (m ? m[1] : e.text).trim();
}
function signature(tool, summary) {
  const basis = `${tool}::${errorClass(summary)}`;
  return SIG_PREFIX + createHash2("sha256").update(basis).digest("hex").slice(0, 12);
}
function errorCaptures(capturedIds, all = readAll()) {
  const idSet = capturedIds && capturedIds.length ? new Set(capturedIds) : null;
  return all.filter(
    (e) => e.type === "fact" && e.tags.includes("capture:error") && e.provenance.origin?.kind === "tool_call" && !/^kb_|vfkb/i.test(toolOf(e)) && (!idSet || idSet.has(e.id))
  );
}
function distillCandidates(capturedIds, all = readAll()) {
  const bySig = /* @__PURE__ */ new Map();
  for (const e of errorCaptures(capturedIds, all)) {
    const tool = toolOf(e);
    const summary = summaryOf(e);
    const sig = signature(tool, summary);
    const cur = bySig.get(sig);
    if (cur) {
      cur.sourceIds.push(e.id);
      continue;
    }
    bySig.set(sig, {
      sig,
      tool,
      // Trust lives in the GLYPH/provenance (provStatus below), NOT baked into the immutable
      // text — so when corroborated promotion re-stamps the entry verified (D-iii/ADR-0024) the
      // text doesn't contradict the ✓. (Text-Brake-safe: only new distills; never rewrites existing.)
      text: `Tool ${tool} can fail: ${summary} \u2014 auto-distilled from a captured failure`,
      sourceIds: [e.id],
      origin: { kind: "tool_call", tool }
    });
  }
  return [...bySig.values()];
}
function distill(capturedIds) {
  const all = readAll();
  const existingBySig = /* @__PURE__ */ new Map();
  for (const e of all) {
    if (e.zone === "archive") continue;
    const sigTag = e.tags.find((t) => t.startsWith(SIG_PREFIX));
    if (sigTag) existingBySig.set(sigTag, e);
  }
  const created = [];
  const corroborated = [];
  for (const c of distillCandidates(capturedIds, all)) {
    const existing = existingBySig.get(c.sig);
    if (existing) {
      recordSignal(existing.id, "helpful", "distill:recurrence");
      corroborated.push(existing.id);
      continue;
    }
    const entry = addEntry("gotcha", c.text, {
      role: "executor",
      // agent-trust (deriveTrust → 'agent')
      zone: "incoming",
      // CONTAINMENT — never the trusted set
      provStatus: "unverified",
      // CONTAINMENT — never verified by machine extraction
      tags: [DISTILLED_TAG, c.sig, `tool:${c.tool}`],
      origin: c.origin
    });
    created.push(entry);
    existingBySig.set(c.sig, entry);
  }
  return { created, corroborated };
}

// src/read.ts
var DEFAULT_MIN_TERM_RATIO = 1 / 3;
function arr(v) {
  if (v === void 0) return void 0;
  return Array.isArray(v) ? v : [v];
}
function run(opts = {}) {
  const all = readAll();
  const superseded = supersededIds(all);
  const hasText = !!(opts.text && opts.text.trim());
  const scored = hasText ? selectIndex().searchScored(opts.text, 200) : [];
  const minRatio = opts.minTermRatio ?? DEFAULT_MIN_TERM_RATIO;
  const qTerms = hasText ? queryTermCount(opts.text) : 0;
  const floored = hasText && qTerms > 0 && minRatio > 0 ? scored.filter((s) => s.matched / qTerms >= minRatio) : scored;
  const scoreOf = new Map(floored.map((s) => [s.entry.id, s.score]));
  const candidates = hasText ? floored.map((s) => s.entry) : all;
  const types = arr(opts.type);
  const zones = arr(opts.zone);
  const statuses = arr(opts.status);
  const roles = arr(opts.authorRole);
  const filteredOut = {};
  const filtered = candidates.filter((e) => {
    let reason = null;
    if (types && !types.includes(e.type)) reason = "type";
    else if (zones && !zones.includes(e.zone)) reason = "zone";
    else if (roles && !roles.includes(e.author.role)) reason = "role";
    else if (opts.verifiedOnly && e.provenance.status !== "verified") reason = "provenance";
    else if (opts.tags && !opts.tags.every((t) => e.tags.includes(t))) reason = "tags";
    else if (statuses) {
      const eff = effectiveStatus(e, superseded);
      if (!eff || !statuses.includes(eff)) reason = "status";
    }
    if (!reason && superseded.has(e.id) && !opts.includeSuperseded) reason = "superseded";
    if (!reason && !opts.includeStale && !isInjectable(e)) reason = "stale";
    if (reason) {
      filteredOut[reason] = (filteredOut[reason] ?? 0) + 1;
      return false;
    }
    return true;
  });
  const ranked = hasText ? [...filtered].sort((a, b) => {
    const s = (scoreOf.get(b.id) ?? 0) - (scoreOf.get(a.id) ?? 0);
    return s !== 0 ? s : heuristicCompare(a, b);
  }) : rerank(filtered);
  const results = opts.limit ? ranked.slice(0, opts.limit) : ranked;
  if (results.length > 0) return { results };
  let diagnosis;
  if (candidates.length > 0) {
    diagnosis = { reason: "all_filtered", candidates: candidates.length, filteredOut };
  } else if (hasText && scored.length > 0) {
    const b = scored[0];
    diagnosis = { reason: "no_match", candidates: 0, belowFloor: { entry: b.entry, matched: b.matched, queryTerms: qTerms } };
  } else {
    diagnosis = { reason: "empty_topic", candidates: 0 };
  }
  return { results, diagnosis };
}
function queryExplained(opts = {}) {
  return run(opts);
}

// src/gating.ts
import { resolve as resolve2 } from "node:path";
var WRITE_TOOLS = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "create",
  "str_replace_editor"
]);
function extractPath(input) {
  if (!input) return void 0;
  const p = input.file_path ?? input.path ?? input.filePath ?? input.notebook_path;
  return typeof p === "string" ? p : void 0;
}
function isBrainWrite(toolName, input, brain = brainDir()) {
  if (!toolName || !WRITE_TOOLS.has(toolName.toLowerCase())) return false;
  const p = extractPath(input);
  if (!p) return false;
  const abs = resolve2(p);
  const root = resolve2(brain);
  return abs === root || abs.startsWith(root + "/");
}
var GATING_REASON = "vfkb: edit the brain via the engine/CLI/MCP, not by writing files directly (keeps the index, freshness, and no-secrets invariants).";

// src/stop-reminder.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join4, relative } from "node:path";
var STOP_REMINDER = 'vfkb decision-capture check: this turn changed code/docs but no `decision` was recorded to the brain. If a load-bearing decision was made, capture it now via `mcp__vfkb__kb_add` (type=decision, why=<rationale>, role=human) \u2014 or `vfkb add decision "\u2026" --why "\u2026" --role human` \u2014 and add an ADR under docs/adr/ for anything architectural. If NO decision was made this turn, just finish normally.';
var HANDOFF_MIN_ENTRIES = 3;
var HANDOFF_REMINDER = 'vfkb handoff check: this session has recorded knowledge but no `handoff`/`next` entry. If you are WRAPPING UP, record a durable handoff now \u2014 `mcp__vfkb__kb_add` (type=fact, tags=handoff,next, role=human) naming what the NEXT session should pick up (a real "next:", not just a summary). If you are still mid-session, ignore this and finish normally \u2014 the SessionEnd floor will leave a fallback if you never do.';
function decideStop(input, ctx) {
  if (input?.stop_hook_active) return { block: false };
  const reminders = [];
  if (ctx.uncommittedWork && ctx.newDecisions === 0) reminders.push(STOP_REMINDER);
  if (ctx.uncommittedWork && (ctx.newEntries ?? 0) >= HANDOFF_MIN_ENTRIES && (ctx.newHandoffs ?? 0) === 0)
    reminders.push(HANDOFF_REMINDER);
  if (reminders.length === 0) return { block: false };
  return { block: true, reminder: reminders.join("\n\n") };
}
function hasUncommittedWork(cwd = process.cwd(), brain = brainDir()) {
  let out;
  try {
    out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return false;
  }
  const brainRel = relative(cwd, brain).replace(/\\/g, "/");
  return out.split("\n").some((line) => {
    const p = line.slice(3).trim();
    if (!p) return false;
    if (brainRel && (p === brainRel || p.startsWith(brainRel + "/"))) return false;
    return p.startsWith("src/") || p.startsWith("docs/");
  });
}
function newBrainEntriesSinceHead(brain = brainDir(), cwd = process.cwd()) {
  const file = join4(brain, "entries.jsonl");
  let current;
  try {
    current = readFileSync4(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const rel = relative(cwd, file).replace(/\\/g, "/");
  let headCount = 0;
  try {
    const head = execFileSync("git", ["show", `HEAD:${rel}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    headCount = head.split("\n").filter(Boolean).length;
  } catch {
    headCount = 0;
  }
  return current.slice(headCount).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((e) => e !== null);
}
var isHandoff = (e) => (e.tags ?? []).some((t) => t === "handoff" || t === "next");
function gatherStopContext(cwd = process.cwd(), brain = brainDir()) {
  const fresh = newBrainEntriesSinceHead(brain, cwd);
  return {
    uncommittedWork: hasUncommittedWork(cwd, brain),
    newDecisions: fresh.filter((e) => e.type === "decision").length,
    newEntries: fresh.length,
    newHandoffs: fresh.filter(isHandoff).length
  };
}

// src/git.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { join as join5 } from "node:path";
function git(args, cwd) {
  return execFileSync2("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function ensureRepo(brain) {
  if (!existsSync4(join5(brain, ".git"))) {
    git(["init", "-q"], brain);
  }
}
function save(message = "vfkb: update", role = "engine", brain = brainDir()) {
  ensureRepo(brain);
  git(["add", "-A"], brain);
  const status = git(["status", "--porcelain"], brain).trim();
  if (status.length === 0) return { committed: false, message: "nothing to commit" };
  git(
    [
      "-c",
      `user.name=vfkb (${role})`,
      "-c",
      "user.email=vfkb@vilosource.local",
      "commit",
      "-q",
      "-m",
      message
    ],
    brain
  );
  return { committed: true, message };
}

// src/session-end.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join6, isAbsolute } from "node:path";
var realGit = (args, cwd) => execFileSync3("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function brainEntriesRelPath(dataDir) {
  return join6(dataDir, "entries.jsonl").replace(/\\/g, "/");
}
function tryGit(git2, args, cwd) {
  try {
    return git2(args, cwd).trim();
  } catch {
    return null;
  }
}
function countAdded(git2, cwd, path) {
  let added = 0;
  for (const base of [["diff"], ["diff", "--cached"]]) {
    const out = tryGit(git2, [...base, "--numstat", "--", path], cwd);
    if (!out) continue;
    for (const line of out.split("\n")) {
      const n = Number(line.split("	")[0]);
      if (Number.isFinite(n)) added += n;
    }
  }
  return added;
}
function newEntriesSinceHead(git2, cwd, repoRelEntries, absEntries) {
  let lines;
  try {
    lines = readFileSync5(absEntries, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  let headCount = 0;
  const head = tryGit(git2, ["show", `HEAD:${repoRelEntries}`], cwd);
  if (head !== null) headCount = head.split("\n").filter(Boolean).length;
  return lines.slice(headCount).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((e) => e !== null);
}
var isHandoff2 = (e) => (e.tags ?? []).some((t) => t === "handoff" || t === "next");
var oneLine = (s) => (s || "").replace(/\s+/g, " ").trim();
function writeAutoHandoff(absBrain, fresh) {
  const CAP = 12;
  const list = fresh.slice(0, CAP).map((e) => `${e.id ?? "?"} [${e.type ?? "?"}] ${oneLine(e.text ?? "").slice(0, 70)}`).join("; ");
  const more = fresh.length > CAP ? ` (+${fresh.length - CAP} more)` : "";
  const n = fresh.length;
  const text = `Auto-handoff (session-end): no explicit handoff was recorded, but this session added ${n} brain entr${n === 1 ? "y" : "ies"} since the last commit \u2014 ${list}${more}. Next session: review these and record an explicit \`next:\` if continuing.`;
  const prev = process.env.VFKB_DATA_DIR;
  process.env.VFKB_DATA_DIR = absBrain;
  try {
    addEntry("fact", text, { role: "executor", zone: "established", tags: ["handoff", "next", "auto"] });
  } finally {
    if (prev === void 0) delete process.env.VFKB_DATA_DIR;
    else process.env.VFKB_DATA_DIR = prev;
  }
}
function defaultBranch(git2, cwd) {
  const ref = tryGit(git2, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (ref && ref.startsWith("origin/")) return ref.slice("origin/".length);
  return "main";
}
function runSessionEnd(opts = {}) {
  const git2 = opts.git ?? realGit;
  const cwd = opts.cwd || process.cwd();
  const dataDir = opts.dataDir || process.env.VFKB_DATA_DIR || process.env.VFKB_DIR || ".vfkb";
  const sessionId = opts.sessionId ?? process.env.KB_SESSION_ID;
  const entries = brainEntriesRelPath(dataDir);
  try {
    if (tryGit(git2, ["rev-parse", "--is-inside-work-tree"], cwd) !== "true") {
      return { committed: false, reason: "not-a-repo" };
    }
    const status = tryGit(git2, ["status", "--porcelain", "--", entries], cwd);
    if (!status) return { committed: false, reason: "brain-clean" };
    const tag = sessionId ? `, session ${sessionId.slice(0, 8)}` : "";
    const branch = tryGit(git2, ["symbolic-ref", "--short", "-q", "HEAD"], cwd) || "";
    const def = defaultBranch(git2, cwd);
    if (!branch) {
      const added2 = countAdded(git2, cwd, entries);
      return {
        committed: false,
        reason: "detached-head",
        added: added2,
        systemMessage: `vfkb: ${added2} new brain entr${added2 === 1 ? "y" : "ies"} uncommitted (detached HEAD) \u2014 check out a branch and commit to preserve continuity.`
      };
    }
    if (branch === def || branch === "main" || branch === "master") {
      const added2 = countAdded(git2, cwd, entries);
      return {
        committed: false,
        reason: "on-default-branch",
        branch,
        added: added2,
        systemMessage: `vfkb: ${added2} new brain entr${added2 === 1 ? "y" : "ies"} on \`${branch}\` left uncommitted \u2014 branch + commit to preserve continuity (vfkb never auto-commits the default branch).`
      };
    }
    const absBrain = isAbsolute(dataDir) ? dataDir : join6(cwd, dataDir);
    const fresh = newEntriesSinceHead(git2, cwd, entries, join6(absBrain, "entries.jsonl"));
    let autoHandoff = false;
    if (fresh.length > 0 && !fresh.some(isHandoff2)) {
      try {
        writeAutoHandoff(absBrain, fresh);
        autoHandoff = true;
      } catch {
      }
    }
    const added = countAdded(git2, cwd, entries);
    const message = `chore(brain): session-end auto-commit (${added} new entr${added === 1 ? "y" : "ies"}${tag})`;
    git2(["add", "--", entries], cwd);
    git2(["commit", "-o", "-m", message, "--", entries], cwd);
    return { committed: true, reason: "committed", branch, added, message, autoHandoff };
  } catch {
    return { committed: false, reason: "error" };
  }
}

// src/init.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename2, join as join8 } from "node:path";

// src/manifest.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join7 } from "node:path";

// src/version.ts
var SCHEMA_VERSION = 1;
var ENGINE_VERSION = true ? "0.1.0" : "0.0.0-dev";
var ENGINE_COMMIT = true ? "2fb286b" : "dev";

// src/manifest.ts
function manifestPath(brainDir2) {
  return join7(brainDir2, "manifest.json");
}
function currentManifest() {
  return { schema_version: SCHEMA_VERSION, engine_version: ENGINE_VERSION, engine_commit: ENGINE_COMMIT };
}
function readManifest(brainDir2) {
  const p = manifestPath(brainDir2);
  if (!existsSync5(p)) return void 0;
  try {
    return JSON.parse(readFileSync6(p, "utf8"));
  } catch {
    return void 0;
  }
}
function writeManifest(brainDir2) {
  const p = manifestPath(brainDir2);
  const existed = existsSync5(p);
  const cur = readManifest(brainDir2);
  const next = currentManifest();
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return "skipped";
  mkdirSync4(dirname2(p), { recursive: true });
  writeFileSync3(p, JSON.stringify(next, null, 2) + "\n");
  return existed ? "updated" : "created";
}

// src/init.ts
var AGENTS_MARKER = "<!-- vfkb:how-we-track-work -->";
var BOOTSTRAP_REL = ".vfkb/bin/bootstrap.mjs";
function mcpConfig(project) {
  return {
    command: "node",
    args: [BOOTSTRAP_REL, "mcp"],
    env: { VFKB_DATA_DIR: ".vfkb", VFKB_PROJECT: project }
  };
}
function hookCommand(project, sub) {
  const root = "${CLAUDE_PROJECT_DIR:-.}";
  return `VFKB_DATA_DIR=${root}/.vfkb VFKB_PROJECT=${project} node ${root}/${BOOTSTRAP_REL} cli hook ${sub}`;
}
var BOOTSTRAP_VERSION = 2;
var BOOTSTRAP_SRC = `#!/usr/bin/env node
// vfkb engine bootstrap (ADR-0031) \u2014 vfkb-bootstrap-version: ${BOOTSTRAP_VERSION}
// Committed at a RELATIVE path so it is always resolvable. Resolves the real
// engine via $VFKB_BUNDLE_DIR at runtime; degrades GRACEFULLY (clear, actionable
// message; never breaks the session) when it is unset or the bundles are missing.
// DO NOT hand-edit \u2014 regenerated by \`vfkb init\`.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const mode = process.argv[2] === 'mcp' ? 'mcp' : 'cli';
const passthrough = process.argv.slice(3);
// VFKB_BUNDLE_DIR is canonical; VFKB_HOME is a kept-working deprecated alias.
const home = process.env.VFKB_BUNDLE_DIR || process.env.VFKB_HOME;
const engine = mode === 'mcp' ? 'vfkb-mcp.mjs' : 'vfkb.mjs';
const enginePath = home ? join(home, engine) : '';

const FIX =
  'vfkb is INACTIVE: VFKB_BUNDLE_DIR is not set (or its bundles are missing). ' +
  'Fix: build the bundles in the vfkb repo (\\\`npm run build:bundles\\\`) and ' +
  '\\\`export VFKB_BUNDLE_DIR=/path/to/vfkb/dist/bundles\\\` (see docs/CONSUMER-ONBOARDING.md). ' +
  'Then run \\\`vfkb doctor\\\` to verify.';

if (!home || !existsSync(enginePath)) {
  // SessionStart: inform the user via the injection channel (a valid hook payload).
  if (mode === 'cli' && passthrough[1] === 'session-start') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '\u26A0\uFE0F ' + FIX },
    }));
    process.exit(0);
  }
  // PreToolUse / Stop / MCP: note it, but NEVER block writes or crash the turn.
  process.stderr.write('vfkb-bootstrap: ' + FIX + '\\n');
  process.exit(0);
}

// Resolved \u2014 run the real engine transparently (stdio passed through).
const r = spawnSync('node', [enginePath, ...passthrough], { stdio: 'inherit' });
process.exit(r.status == null ? 0 : r.status);
`;
function settingsHooks(project) {
  return {
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand(project, "session-start") }] }],
    PreToolUse: [
      { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: hookCommand(project, "pre-tool-use") }] }
    ],
    Stop: [{ hooks: [{ type: "command", command: hookCommand(project, "stop") }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: hookCommand(project, "session-end") }] }]
  };
}
function agentsSnippet(project) {
  return `${AGENTS_MARKER}
## How we track work HERE \u2014 vfkb

This repo uses **vfkb** as its knowledge substrate (project \`${project}\`). Knowledge is recorded
**deliberately, through the engine** \u2014 never by hand-editing \`.vfkb/\` (a PreToolUse hook gates that).

- **Session start** injects the resume digest + knowledge bundle automatically (SessionStart hook).
- **Record knowledge** with the \`mcp__vfkb__kb_add\` tool (or \`node .vfkb/bin/bootstrap.mjs cli add \u2026\`):
  \`decision\`, \`fact\`, \`gotcha\`, \`pattern\`, \`link\` \u2014 put a decision's rationale in its text.
  **Capture load-bearing decisions immediately \u2014 don't defer.**
- Only \`.vfkb/entries.jsonl\`, \`.vfkb/manifest.json\`, and \`.vfkb/bin/\` are committed;
  \`.vfkb/index-meta.json\`, \`.sessions/\`, \`.signals/\` are derived/gitignored.

Two env vars: **\`VFKB_DATA_DIR\`** = this repo's brain (\`.vfkb\`, set by the wiring) \xB7 **\`VFKB_BUNDLE_DIR\`**
= the shared vfkb engine bundles \u2014 set it once per machine, e.g. \`export VFKB_BUNDLE_DIR=/path/to/vfkb/dist/bundles\`.
If it is unset, a session-start banner tells you; run \`vfkb doctor\` to check.
`;
}
function readJson(path) {
  if (!existsSync6(path)) return void 0;
  try {
    return JSON.parse(readFileSync7(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJson(path, value) {
  writeFileSync4(path, JSON.stringify(value, null, 2) + "\n");
}
function eventHasVfkb(arr2) {
  return JSON.stringify(arr2 ?? "").includes(BOOTSTRAP_REL);
}
function initProject(root, opts = {}) {
  const project = opts.project || basename2(root) || "project";
  const changes = [];
  const brainDir2 = join8(root, ".vfkb");
  const entries = join8(brainDir2, "entries.jsonl");
  if (!existsSync6(entries)) {
    mkdirSync5(brainDir2, { recursive: true });
    writeFileSync4(entries, "");
    changes.push({ path: ".vfkb/entries.jsonl", action: "created" });
  } else {
    changes.push({ path: ".vfkb/entries.jsonl", action: "skipped" });
  }
  changes.push({ path: ".vfkb/manifest.json", action: writeManifest(brainDir2) });
  {
    const binDir = join8(brainDir2, "bin");
    const path = join8(binDir, "bootstrap.mjs");
    const existed = existsSync6(path);
    const same = existed && readFileSync7(path, "utf8") === BOOTSTRAP_SRC;
    if (same) {
      changes.push({ path: BOOTSTRAP_REL, action: "skipped" });
    } else {
      mkdirSync5(binDir, { recursive: true });
      writeFileSync4(path, BOOTSTRAP_SRC);
      changes.push({ path: BOOTSTRAP_REL, action: existed ? "updated" : "created" });
    }
  }
  {
    const path = join8(root, ".mcp.json");
    const existed = existsSync6(path);
    const cfg = readJson(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    const desired = mcpConfig(project);
    const same = JSON.stringify(cfg.mcpServers.vfkb) === JSON.stringify(desired);
    if (same) {
      changes.push({ path: ".mcp.json", action: "skipped" });
    } else {
      cfg.mcpServers.vfkb = desired;
      writeJson(path, cfg);
      changes.push({ path: ".mcp.json", action: existed ? "updated" : "created" });
    }
  }
  {
    const dir = join8(root, ".claude");
    const path = join8(dir, "settings.json");
    const existed = existsSync6(path);
    const cfg = readJson(path) ?? {};
    cfg.hooks = cfg.hooks ?? {};
    const want = settingsHooks(project);
    let touched = false;
    for (const event of Object.keys(want)) {
      const raw = cfg.hooks[event];
      const cur = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const others = cur.filter((e) => !eventHasVfkb(e));
      const desired = [...others, ...want[event]];
      if (JSON.stringify(cur) === JSON.stringify(desired)) continue;
      cfg.hooks[event] = desired;
      touched = true;
    }
    if (touched) {
      mkdirSync5(dir, { recursive: true });
      writeJson(path, cfg);
      changes.push({ path: ".claude/settings.json", action: existed ? "updated" : "created" });
    } else {
      changes.push({ path: ".claude/settings.json", action: "skipped" });
    }
  }
  {
    const path = join8(root, ".gitignore");
    const lines = [".vfkb/index-meta.json", ".vfkb/.sessions/", ".vfkb/.signals/"];
    const existed = existsSync6(path);
    const cur = existed ? readFileSync7(path, "utf8") : "";
    const missing = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
    if (missing.length === 0) {
      changes.push({ path: ".gitignore", action: "skipped" });
    } else {
      const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
      const block = `${prefix}${cur ? "\n" : ""}# vfkb \u2014 derived/operational (only .vfkb/entries.jsonl is committed)
${missing.join("\n")}
`;
      writeFileSync4(path, cur + block);
      changes.push({ path: ".gitignore", action: existed ? "updated" : "created" });
    }
  }
  {
    const path = join8(root, "AGENTS.md");
    const existed = existsSync6(path);
    const cur = existed ? readFileSync7(path, "utf8") : "";
    if (cur.includes(AGENTS_MARKER)) {
      changes.push({ path: "AGENTS.md", action: "skipped" });
    } else {
      const sep = cur && !cur.endsWith("\n") ? "\n\n" : cur ? "\n" : "";
      writeFileSync4(path, cur + sep + agentsSnippet(project));
      changes.push({ path: "AGENTS.md", action: existed ? "updated" : "created" });
    }
  }
  return changes;
}
function approvalNotice(project) {
  return [
    `vfkb wired for project "${project}".`,
    "",
    "Next (one-time, manual):",
    "  1. Set $VFKB_BUNDLE_DIR once per machine to the vfkb bundles dir, e.g.:",
    "       export VFKB_BUNDLE_DIR=/path/to/vfkb/dist/bundles   # (run `npm run build:bundles` in the vfkb repo)",
    "  2. Start `claude` in this repo and APPROVE the project MCP server + hooks when prompted (once).",
    "  3. Commit the wiring + the empty brain: git add .mcp.json .claude .gitignore .vfkb AGENTS.md"
  ].join("\n");
}

// src/doctor.ts
import { existsSync as existsSync7, readFileSync as readFileSync8 } from "node:fs";
import { join as join9 } from "node:path";
function readJson2(path) {
  if (!existsSync7(path)) return void 0;
  try {
    return JSON.parse(readFileSync8(path, "utf8"));
  } catch {
    return void 0;
  }
}
function projectFromSettings(settings) {
  const blob = JSON.stringify(settings ?? "");
  const m = blob.match(/VFKB_PROJECT=([^\s"\\]+)/);
  return m?.[1];
}
function runDoctor(opts) {
  const { root, brainDir: brainDir2, env } = opts;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add("engine", "ok", `version ${ENGINE_VERSION} \xB7 commit ${ENGINE_COMMIT} \xB7 schema v${SCHEMA_VERSION}`);
  const mf = readManifest(brainDir2);
  if (!mf) {
    add("brain manifest", "warn", `no manifest.json in ${brainDir2} \u2014 run \`vfkb init\` (or it will be stamped on next write)`);
  } else if (typeof mf.schema_version !== "number") {
    add("brain manifest", "warn", "manifest has no numeric schema_version");
  } else if (mf.schema_version > SCHEMA_VERSION) {
    add("brain\u2194engine compat", "fail", `brain schema v${mf.schema_version} is NEWER than engine v${SCHEMA_VERSION} \u2014 update the engine before using this brain`);
  } else if (mf.schema_version < SCHEMA_VERSION) {
    add("brain\u2194engine compat", "warn", `brain schema v${mf.schema_version} is older than engine v${SCHEMA_VERSION} \u2014 migration may be needed`);
  } else {
    add("brain\u2194engine compat", "ok", `schema v${mf.schema_version} matches`);
    if (mf.engine_commit && ENGINE_COMMIT !== "dev" && mf.engine_commit !== ENGINE_COMMIT) {
      add("engine drift", "warn", `brain last stamped by engine ${mf.engine_commit}, running ${ENGINE_COMMIT} \u2014 possible dual-clone drift`);
    }
  }
  const home = env.VFKB_BUNDLE_DIR || env.VFKB_HOME;
  if (!home) {
    add("$VFKB_BUNDLE_DIR", "warn", "unset \u2014 set it once per machine to the vfkb bundles dir (so the wiring resolves the engine)");
  } else if (!existsSync7(join9(home, "vfkb.mjs")) || !existsSync7(join9(home, "vfkb-mcp.mjs"))) {
    add("$VFKB_BUNDLE_DIR", "warn", `set to ${home} but vfkb.mjs / vfkb-mcp.mjs not found there (run \`npm run build:bundles\`)`);
  } else {
    add("$VFKB_BUNDLE_DIR", "ok", home);
  }
  if (env.VFKB_DIR && !env.VFKB_DATA_DIR) {
    add("env (deprecated)", "warn", "VFKB_DIR is a deprecated alias \u2014 rename it to VFKB_DATA_DIR");
  }
  if (env.VFKB_HOME && !env.VFKB_BUNDLE_DIR) {
    add("env (deprecated)", "warn", "VFKB_HOME is a deprecated alias \u2014 rename it to VFKB_BUNDLE_DIR");
  }
  const mcp = readJson2(join9(root, ".mcp.json"));
  const mcpProject = mcp?.mcpServers?.vfkb?.env?.VFKB_PROJECT;
  if (!mcp?.mcpServers?.vfkb) {
    add(".mcp.json", "warn", "no vfkb MCP server registered \u2014 run `vfkb init`");
  } else {
    add(".mcp.json", "ok", `vfkb server present (project ${mcpProject ?? "?"})`);
  }
  const settings = readJson2(join9(root, ".claude", "settings.json"));
  const hooks = settings?.hooks ?? {};
  const expected = ["SessionStart", "PreToolUse", "Stop", "SessionEnd"];
  const have = expected.filter((e) => JSON.stringify(hooks[e] ?? "").includes("vfkb"));
  if (have.length === 0) {
    add(".claude/settings.json", "warn", "no vfkb hooks \u2014 run `vfkb init`");
  } else if (have.length < expected.length) {
    add(".claude/settings.json", "warn", `only ${have.join(", ")} wired (expected ${expected.join(", ")})`);
  } else {
    add(".claude/settings.json", "ok", `${have.join(", ")} wired`);
  }
  const hooksBlob = JSON.stringify(hooks ?? "");
  if (have.length > 0 && hooksBlob.includes("bootstrap.mjs") && !hooksBlob.includes("CLAUDE_PROJECT_DIR")) {
    add("hooks anchor", "warn", "vfkb hooks use a CWD-relative bootstrap path \u2014 they break when the session cd's out of the repo root; re-run `vfkb init` to anchor them to $CLAUDE_PROJECT_DIR (issue #22)");
  }
  if (existsSync7(join9(root, ".vfkb", "bin", "bootstrap.mjs"))) {
    add("bootstrap", "ok", ".vfkb/bin/bootstrap.mjs present");
  } else if (mcp?.mcpServers?.vfkb || have.length > 0) {
    add("bootstrap", "warn", "wiring present but .vfkb/bin/bootstrap.mjs is missing \u2014 run `vfkb init`");
  }
  const settingsProject = projectFromSettings(settings);
  if (mcpProject && settingsProject && mcpProject !== settingsProject) {
    add("VFKB_PROJECT", "fail", `mismatch: .mcp.json says "${mcpProject}", settings says "${settingsProject}"`);
  } else if (mcpProject || settingsProject) {
    add("VFKB_PROJECT", "ok", `${mcpProject ?? settingsProject}`);
  }
  return { checks, ok: !checks.some((c) => c.status === "fail") };
}
var ICON = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
function renderDoctor(report) {
  const lines = report.checks.map((c) => `${ICON[c.status]}  ${c.name} \u2014 ${c.detail}`);
  lines.push("");
  lines.push(report.ok ? "doctor: OK (no failures)" : "doctor: FAIL \u2014 fix the FAIL item(s) above");
  return lines.join("\n");
}

// src/import.ts
import { existsSync as existsSync8, readdirSync as readdirSync2, readFileSync as readFileSync9, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename as basename3, extname, join as join10 } from "node:path";
var MYKB_FILES = {
  "decisions.jsonl": "decision",
  "facts.jsonl": "fact",
  "gotchas.jsonl": "gotcha",
  "patterns.jsonl": "pattern",
  "links.jsonl": "link"
};
function stamp(type, text, tags, verified) {
  const e = addEntry(type, text, {
    role: "import",
    tags: ["imported", ...tags.filter((t) => t !== "imported")],
    provStatus: verified ? "verified" : "unverified"
  });
  return { id: e.id, type: e.type, text: e.text };
}
function mykbText(type, e) {
  const parts = [String(e.text ?? "").trim()];
  if (type === "decision" && e.why) parts.push(`Why: ${e.why}`);
  if (type === "decision" && e.rejected) parts.push(`Rejected: ${e.rejected}`);
  if (type === "gotcha" && e.resolution) parts.push(`Resolution: ${e.resolution}`);
  if (type === "link" && e.url) return `${parts[0]} \u2192 ${e.url}`;
  return parts.filter(Boolean).join("\n\n");
}
function resolveMykbArea(nameOrDir) {
  if (existsSync8(nameOrDir) && statSync(nameOrDir).isDirectory()) return nameOrDir;
  return join10(homedir2(), ".mykb", "areas", nameOrDir);
}
function fromMykb(areaDir) {
  if (!existsSync8(areaDir)) throw new Error(`mykb area not found: ${areaDir}`);
  const out = [];
  for (const [file, type] of Object.entries(MYKB_FILES)) {
    const path = join10(areaDir, file);
    if (!existsSync8(path)) continue;
    for (const line of readFileSync9(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let e;
      try {
        e = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const text = mykbText(type, e);
      if (!text) continue;
      const verified = e?.provenance?.status === "verified";
      out.push(stamp(type, text, Array.isArray(e.tags) ? e.tags : [], verified));
    }
  }
  return out;
}
function mdTitle(path) {
  try {
    const heading = readFileSync9(path, "utf8").split(/\r?\n/).find((l) => l.startsWith("# "));
    if (heading) return heading.replace(/^#\s+/, "").trim();
  } catch {
  }
  return basename3(path, extname(path));
}
function fromAdr(dir = "docs/adr") {
  if (!existsSync8(dir)) throw new Error(`ADR dir not found: ${dir}`);
  const out = [];
  for (const file of readdirSync2(dir).sort()) {
    if (extname(file) !== ".md" || /readme/i.test(file)) continue;
    const rel = join10(dir, file);
    out.push(stamp("link", `${mdTitle(rel)} \u2192 ${rel}`, ["adr"], false));
  }
  return out;
}
function fromMarkdown(file) {
  if (!existsSync8(file)) throw new Error(`markdown file not found: ${file}`);
  return [stamp("link", `${mdTitle(file)} \u2192 ${file}`, ["doc"], false)];
}

// src/cli.ts
function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    if (process.stdin.isTTY) return resolve3("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => data += c);
    process.stdin.on("end", () => resolve3(data));
    setTimeout(() => resolve3(data), 2e3).unref?.();
  });
}
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : void 0;
}
async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (cmd === "add") {
    const type = sub;
    const role = flag(rest, "role") || "executor";
    const tags = flag(rest, "tag")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
    try {
      const e = addEntry(type, cleanText(rest), {
        role,
        why: flag(rest, "why"),
        tags,
        status: flag(rest, "status"),
        provStatus: flag(rest, "prov-status"),
        validUntil: flag(rest, "valid-until"),
        zone: flag(rest, "zone"),
        constitutional: rest.includes("--constitutional")
      });
      process.stdout.write(`${e.id}	[${e.type} ${deriveTrust(e.author.role)}]	${e.text}
`);
    } catch (err) {
      process.stderr.write(`error: ${err.message}
`);
      process.exit(1);
    }
    return;
  }
  if (cmd === "init") {
    const root = process.cwd();
    const project = (sub && !sub.startsWith("--") ? sub : void 0) || process.env.VFKB_PROJECT;
    const changes = initProject(root, { project });
    const resolved = project || root.split(/[/\\]/).filter(Boolean).pop() || "project";
    for (const c of changes) process.stdout.write(`${c.action}	${c.path}
`);
    process.stdout.write("\n" + approvalNotice(resolved) + "\n");
    return;
  }
  if (cmd === "import") {
    const args = [sub, ...rest].filter((a) => a !== void 0);
    const results = [];
    try {
      if (args.includes("--from-adr")) results.push(...fromAdr(flag(args, "from-adr") || "docs/adr"));
      const md = flag(args, "from-markdown");
      if (md) results.push(...fromMarkdown(md));
      const mykb = flag(args, "from-mykb");
      if (mykb) results.push(...fromMykb(resolveMykbArea(mykb)));
    } catch (err) {
      process.stderr.write(`error: ${err.message}
`);
      process.exit(1);
    }
    if (results.length === 0) {
      process.stderr.write("import: nothing imported \u2014 pass --from-mykb <area> | --from-adr [dir] | --from-markdown <file>\n");
      process.exit(1);
    }
    for (const r of results) process.stdout.write(`${r.id}	${r.type}	${r.text.split("\n")[0].slice(0, 80)}
`);
    process.stdout.write(`
imported ${results.length} entr${results.length === 1 ? "y" : "ies"} (role=import, unverified)
`);
    return;
  }
  if (cmd === "doctor") {
    const report = runDoctor({
      root: process.cwd(),
      brainDir: process.env.VFKB_DATA_DIR || process.env.VFKB_DIR || ".vfkb",
      env: process.env
    });
    process.stdout.write(renderDoctor(report) + "\n");
    if (!report.ok) process.exit(1);
    return;
  }
  if (cmd === "list") {
    for (const e of readAll()) {
      process.stdout.write(
        `${e.id}	${e.type}	${deriveTrust(e.author.role)}	${e.provenance.status}	${e.text}
`
      );
    }
    return;
  }
  if (cmd === "context-block") {
    process.stdout.write(renderContextBundle(sub || defaultProject()));
    return;
  }
  if (cmd === "map") {
    process.stdout.write(renderContextMap() + "\n");
    return;
  }
  if (cmd === "context") {
    if (sub === "init") {
      const { created, path } = initContextSpine();
      process.stdout.write(`${created ? "created" : "exists"}	${path}
`);
      return;
    }
    const project = (sub && !sub.startsWith("--") ? sub : void 0) || defaultProject();
    process.stdout.write(renderContext(project));
    return;
  }
  if (cmd === "resume") {
    const project = (sub && !sub.startsWith("--") ? sub : void 0) || defaultProject();
    process.stdout.write(renderResume(project, SessionState.load()) + "\n");
    return;
  }
  if (cmd === "curate") {
    try {
      if (sub === "dups") {
        const dups = findLexicalDuplicates();
        for (const d of dups) process.stdout.write(`DUP	loser=${d.loser}	winner=${d.winner}
`);
        if (dups.length === 0) process.stdout.write("no exact lexical duplicates\n");
      } else if (sub === "signal") {
        const kind = rest[1];
        if (kind !== "helpful" && kind !== "harmful") {
          process.stderr.write("usage: vfkb curate signal <id> <helpful|harmful>\n");
          process.exit(1);
        }
        recordSignal(rest[0], kind, "operator");
        const t = tally(rest[0]);
        process.stdout.write(
          `signal ${kind} -> ${rest[0]} (helpful ${t.helpful} / harmful ${t.harmful} / net ${t.net}${eligibleForPromotion(rest[0]) ? ", promotable" : ""})
`
        );
      } else if (sub === "promote-auto") {
        const e = promoteIfCorroborated(rest[0]);
        process.stdout.write(`promoted (corroborated) ${e.id} -> ${e.zone}
`);
      } else if (sub === "promote") {
        const e = promote(rest[0]);
        process.stdout.write(`promoted ${e.id} -> ${e.zone}
`);
      } else if (sub === "archive") {
        const e = archive(rest[0]);
        process.stdout.write(`archived ${e.id}
`);
      } else if (sub === "merge") {
        mergeDuplicate(rest[0], rest[1]);
        process.stdout.write(`merged ${rest[0]} -> ${rest[1]} (loser archived)
`);
      } else {
        process.stderr.write(
          "usage: vfkb curate <dups|promote <id>|promote-auto <id>|archive <id>|merge <loser> <winner>|signal <id> <helpful|harmful>>\n"
        );
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}
`);
      process.exit(1);
    }
    return;
  }
  if (cmd === "distill") {
    const session = SessionState.load();
    const ids = session.capturedIds;
    const { created, corroborated } = distill(ids.length ? ids : void 0);
    session.save();
    for (const e of created) process.stdout.write(`CANDIDATE	${e.id}	incoming/unverified	${e.text}
`);
    for (const id of corroborated) process.stdout.write(`CORROBORATED	${id}	${tally(id).net} net
`);
    if (created.length === 0 && corroborated.length === 0) {
      process.stdout.write("no distillable failure signals\n");
    }
    return;
  }
  if (cmd === "resume-note") {
    const session = SessionState.load();
    const note = cleanText([sub, ...rest].filter((a) => a !== void 0));
    if (!note) {
      process.stderr.write("usage: vfkb resume-note <text>\n");
      process.exit(1);
    }
    session.setNote(note);
    session.save();
    process.stdout.write(
      session.sessionId ? `noted for session ${session.sessionId}: ${note}
` : `note set (ephemeral \u2014 set KB_SESSION_ID to persist): ${note}
`
    );
    return;
  }
  if (cmd === "context-block-naive") {
    const lim = flag([sub, ...rest], "limit");
    process.stdout.write(renderNaiveDump(sub && !sub.startsWith("--") ? sub : defaultProject(), void 0, lim ? Number(lim) : void 0));
    return;
  }
  if (cmd === "supersede") {
    try {
      const e = supersede(sub, cleanText(rest), {
        role: flag(rest, "role") || "human",
        why: flag(rest, "why")
      });
      process.stdout.write(`${e.id}	supersedes ${sub}	${e.text}
`);
    } catch (err) {
      process.stderr.write(`error: ${err.message}
`);
      process.exit(1);
    }
    return;
  }
  if (cmd === "search" || cmd === "query") {
    const args = [sub, ...rest].filter((a) => a !== void 0);
    const text = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))).join(" ");
    const limit = flag(args, "limit");
    const { results, diagnosis } = queryExplained({
      text: text || void 0,
      type: flag(args, "type"),
      zone: flag(args, "zone"),
      status: flag(args, "status"),
      tags: flag(args, "tag")?.split(",").map((t) => t.trim()).filter(Boolean),
      authorRole: flag(args, "role"),
      verifiedOnly: args.includes("--verified"),
      limit: limit ? Number(limit) : void 0,
      includeStale: args.includes("--stale"),
      includeSuperseded: args.includes("--superseded")
    });
    for (const e of results) {
      process.stdout.write(`${e.id}	${e.type}	${deriveTrust(e.author.role)}	${e.text}
`);
    }
    if (results.length === 0 && diagnosis) {
      const extra = diagnosis.reason === "all_filtered" ? ` (${diagnosis.candidates} filtered: ${Object.entries(diagnosis.filteredOut ?? {}).map(([k, v]) => `${v} ${k}`).join(", ")})` : diagnosis.reason === "no_match" && diagnosis.belowFloor ? ` (closest below floor, low confidence: ${diagnosis.belowFloor.entry.text})` : "";
      process.stdout.write(`NO-MATCH	${diagnosis.reason}	no recorded entry found${extra}
`);
    }
    return;
  }
  if (cmd === "hook") {
    if (sub === "session-start") {
      await readStdin();
      const project = defaultProject();
      const lim = flag(rest, "limit");
      const session = SessionState.load();
      const additionalContext = rest.includes("--naive") ? renderNaiveDump(project, void 0, lim ? Number(lim) : void 0) : renderResume(project, session);
      session.save();
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }
        })
      );
      return;
    }
    if (sub === "post-tool-use") {
      const raw = await readStdin();
      try {
        const payload = JSON.parse(raw || "{}");
        const captured = captureToolCall({
          tool_name: payload.tool_name,
          tool_input: payload.tool_input,
          // Claude Code's PostToolUse payload carries the result under `tool_response`
          // ({stdout,stderr,…}), NOT `tool_result` (verified 2026-06-27). Without this
          // fallback the result was dropped → every live capture classified `ok` → no
          // capture:error → the distiller never fired on a real claude failure (D-iv,
          // the claude analog of the pi tool_call-has-no-result gap). The host-side
          // synthetic seam feeds `tool_result`, so it keeps precedence.
          tool_result: payload.tool_result ?? payload.tool_response,
          call_id: payload.call_id || payload.tool_use_id
        });
        if (captured) {
          const session = SessionState.load();
          session.recordCaptured(captured.id);
          session.save();
        }
      } catch {
      }
      process.stdout.write("{}");
      return;
    }
    if (sub === "stop") {
      const raw = await readStdin();
      let input = {};
      try {
        input = JSON.parse(raw || "{}");
      } catch {
      }
      if (input.stop_hook_active) {
        process.stdout.write("{}");
        return;
      }
      const d = decideStop({ stop_hook_active: false }, gatherStopContext());
      process.stdout.write(
        d.block ? JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            decision: "block",
            additionalContext: d.reminder
          }
        }) : "{}"
      );
      return;
    }
    if (sub === "session-end") {
      const raw = await readStdin();
      let cwd;
      let sessionId;
      try {
        const payload = JSON.parse(raw || "{}");
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (typeof payload.session_id === "string") sessionId = payload.session_id;
      } catch {
      }
      let systemMessage;
      try {
        const r = runSessionEnd({ cwd, sessionId });
        systemMessage = r.systemMessage;
      } catch {
      }
      process.stdout.write(systemMessage ? JSON.stringify({ systemMessage }) : "{}");
      return;
    }
    if (sub === "pre-tool-use") {
      const raw = await readStdin();
      try {
        const payload = JSON.parse(raw || "{}");
        if (isBrainWrite(payload.tool_name, payload.tool_input)) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: GATING_REASON
              }
            })
          );
          return;
        }
      } catch {
      }
      process.stdout.write("{}");
      return;
    }
  }
  if (cmd === "save") {
    const r = save([sub, ...rest].filter((a) => a && !a.startsWith("--")).join(" ") || void 0);
    process.stdout.write((r.committed ? "committed: " : "no-op: ") + r.message + "\n");
    return;
  }
  process.stderr.write(
    "usage: vfkb <add|list|search|query|map|context|context init|resume|resume-note|curate|distill|save|context-block|hook session-start|hook pre-tool-use|hook post-tool-use|hook stop|hook session-end>\n"
  );
  process.exit(1);
}
function cleanText(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out.join(" ").trim();
}
main();
