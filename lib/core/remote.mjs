// The WeCom transport owns authentication, message dedupe, attachments and durable delivery.
// The host adapter turns DeepSeek Harness session events into the turn/activity/result entries below;
// a phone message's requestId is the identity of its loop, so late results never settle another loop.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { saveOwner, VERSION, RESTART_NOTICE_ACTIVE_MS } from "./config.mjs";
import { WeComTransport, MAX_ATTACHMENT_BYTES } from "./wecom.mjs";
import { loadAliases } from "./aliases.mjs";
import { SPOOL_TTL_MS, takeLaunched, takeSpool } from "./watchdog.mjs";
import { artAllowed, freshArtifacts, ingestEvent, listArtifacts } from "./artifacts.mjs";
import { lastTurn } from "./recap.mjs";

export const PHONE_RPC_PREFIX = "wecom-";
const HOME = os.homedir();
const SYNC_WINDOW_MS = 2000;
const RUN_PING_DEFAULT = [10 * 60000, 30 * 60000, 60 * 60000];
const HIST_LIST = 15;
const HIST_FIND_MAX = 20;
const VOTE_OPT_MAX = 20;
const CARD_TTL_MS = 30 * 60000;
const CARD_BODY_MAX = 108;
const EMPH_MAX = 10;
const EMPH_DESC_MAX = 15;
const EMPH_NAME_MAX = 16;
const UI_TEXT_MAX_BYTES = 1200;
const HIST_NAME_MAX = 24;
// 历史检索只用会话名 + 用户输入（turnOutline 的 prompt）前 USER_HEAD_MAX 个字。
const USER_HEAD_MAX = 400;
// 会话空闲后仍未开始的手机消息、漏收 turn/end 的轮次：等这么久再按失联收尾。
const IDLE_REAP_MS = 5000;
const LOOPS_KEEP = 8;
const STOP_GRACE_MS = 5000;
const SYNC_RETRIES = 30;
const SYNC_RETRY_MS = 2000;
// 活跃会话：运行中、当前、置顶的总会列出；其余只列最近这么久有活动的，最多 ACTIVE_MAX 个。
const ACTIVE_RECENT_MS = 24 * 3600_000;
const ACTIVE_MAX = 10;
// Keep completed results inline until they approach WeCom's 20,480-byte
// Markdown limit. The transport sends each message up to the same 20,000-byte
// safety limit; larger completed results are delivered as Markdown documents.
const PUSH_TEXT_MAX_BYTES = 20_000;
const RECAP_TIP = "发送「回顾」，查看上一轮内容";
const ART_LIST_MAX = VOTE_OPT_MAX;
const ART_DIRECT_MAX = 3;
const ART_SEND_MAX = 50 * 1024 * 1024;
const RULE = "---";
const num = (n) => `${n}.`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 19);
const sha8 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/;
const CTRL_RE_G = new RegExp(CTRL_RE.source, "g");
export function stripCtrl(s) {
    if (!CTRL_RE.test(s))
        return s;
    return s.replace(CTRL_RE_G, " ").replace(/ {2,}/g, " ").trim();
}
const CTRL_KEEP_NL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;
const stripCtrlKeepNl = (s) => String(s ?? "").replace(CTRL_KEEP_NL_RE, " ").replace(/[^\S\n]{2,}/g, " ");
const oneLine = (s) => stripCtrl(String(s || "")).replace(/\s+/g, " ").trim();
export function expandPath(p) {
    if (!p)
        return HOME;
    if (p === "~")
        return HOME;
    if (p.startsWith("~/"))
        return path.join(HOME, p.slice(2));
    if (path.isAbsolute(p))
        return p;
    return path.join(HOME, p);
}
/** 向上找 .git（目录或 worktree 文件），读 HEAD 得分支名。 */
function gitBranch(cwd) {
    try {
        for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
            const dotGit = path.join(dir, ".git");
            if (fs.existsSync(dotGit)) {
                let gitDir = dotGit;
                if (fs.statSync(dotGit).isFile()) {
                    const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
                    if (!m)
                        return "";
                    gitDir = path.resolve(dir, m[1].trim());
                }
                const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
                const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
                return ref ? ref[1] : "detached";
            }
            if (path.dirname(dir) === dir)
                return "";
        }
    }
    catch {
        return "";
    }
}
function tilde(p) {
    return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
function branchNote(cwd) {
    const branch = cwd ? gitBranch(cwd) : "";
    return ["", "main", "master", "detached"].includes(branch) ? "" : ` (${branch})`;
}
export function human(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m >= 60)
        return `${Math.floor(m / 60)}小时${m % 60}分`;
    return `${m}分${s % 60}秒`;
}
function ago(mtimeMs) {
    const d = Date.now() - mtimeMs;
    if (d < 120000)
        return "刚刚";
    if (d < 3600000)
        return `${Math.floor(d / 60000)}分钟前`;
    if (d < 86400000)
        return `${Math.floor(d / 3600000)}小时前`;
    if (d < 172800000)
        return "昨天";
    return `${Math.floor(d / 86400000)}天前`;
}
function slugName(s) {
    const cut = Array.from(stripCtrl(String(s || "")).replace(/\s+/g, "-"))
        .filter((ch) => !/[\/\\:*?"<>|'`$&;()\[\]{}：？＊｜“”]/.test(ch))
        .slice(0, 32)
        .join("")
        .replace(/^[-.…]+|[-.…]+$/g, "");
    return cut || "dsh会话";
}
function stampNow(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
/** 按显示宽度截断（CJK/全角算 2，其余算 1），用于想在手机上单行显示的引用。 */
export function clipWidth(s, maxW) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    const w = (c) => (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(c) ? 2 : 1);
    let used = 0, out = "";
    for (const c of Array.from(t)) {
        const cw = w(c);
        if (used + cw > maxW - 1 && used + cw + (Array.from(t).length - Array.from(out).length - 1 > 0 ? 1 : 0) > maxW) return out + "…";
        out += c; used += cw;
    }
    return out;
}
function clip(s, n) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    const cps = Array.from(t);
    return cps.length <= n ? t : cps.slice(0, Math.max(1, n - 1)).join("") + "…";
}
function truncateUtf8(text, maxBytes) {
    let bytes = 0;
    let out = "";
    for (const char of String(text ?? "")) {
        const n = Buffer.byteLength(char);
        if (bytes + n > maxBytes)
            break;
        out += char;
        bytes += n;
    }
    return out;
}
function promptHint(text) {
    const s = stripCtrl(String(text || "")).trim();
    return s ? clip(s, HIST_NAME_MAX) : "";
}
const ASTRAL_TOFU = "□";
const PAIRED_SURROGATE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/g;
const hex = (s) => "U+" + s.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
function stripAstral(s, path, hits) {
    if (!/[\uD800-\uDFFF]/.test(s))
        return s;
    const pairs = [];
    let out = s.replace(PAIRED_SURROGATE_RE, (m) => {
        pairs.push(m);
        return "\u0000" + (pairs.length - 1) + "\u0000";
    });
    out = out.replace(LONE_SURROGATE_RE, (m) => {
        hits.push(`${path}=lone:${hex(m)}`);
        return ASTRAL_TOFU;
    });
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => pairs[Number(i)]);
}
function sanitizeCard(v, path = "card", hits = []) {
    if (typeof v === "string")
        return stripCtrl(stripAstral(v, path, hits));
    if (Array.isArray(v))
        return v.map((x, i) => sanitizeCard(x, `${path}[${i}]`, hits));
    if (v && typeof v === "object") {
        const o = {};
        for (const [k, val] of Object.entries(v)) {
            const nk = stripCtrl(stripAstral(String(k), `${path}.<key>`, hits));
            o[nk] = sanitizeCard(val, `${path}.${nk}`, hits);
        }
        return o;
    }
    return v;
}
const GOAL_PHASE = { active: "执行中", paused: "已暂停", blocked: "受阻", complete: "已完成" };
/** goal 投影 / goal/change 快照 → 目标；没有目标或已清除为 null。 */
export function goalView(p) {
    const g = p?.goal;
    if (!g || typeof g.objective !== "string")
        return null;
    return {
        objective: g.objective,
        phase: String(g.phase || ""),
        maxGoalRounds: Number(g.maxGoalRounds) || 0,
        roundsStarted: Number(p.roundsStarted) || 0,
        blockedReason: g.blockedReason || null,
    };
}
/** 还会自动续跑。undefined 是还没读到目标状态，按继续算，等 goal/change 定局。到达轮数上限时续跑驱动会把目标标为 blocked（round-limit）。 */
const goalLive = (g) => g === undefined || g?.phase === "active";
const goalAtLimit = (g) => g?.blockedReason?.code === "round-limit" || (g && g.roundsStarted >= g.maxGoalRounds);
const goalLine = (g) => `${GOAL_PHASE[g.phase] || g.phase} · ${g.roundsStarted}/${g.maxGoalRounds} 轮`;
function goalEndHead(g) {
    if (!g)
        return "🎯 目标已清除";
    if (g.phase === "complete")
        return "🎯 目标已完成";
    if (g.phase === "blocked")
        return g.blockedReason?.code === "round-limit" ? "🎯 目标到达轮数上限" : "🎯 目标受阻";
    if (g.phase === "paused")
        return "🎯 目标已暂停";
    return "🎯 目标续跑完成";
}
// 三段式：head 用三级标题，放状态 · subject（会话名/对象）；关键信息进 body；foot 只放元信息与引导。
export function plainText({ head, subject = "", body = "", foot = "", extra = "" }) {
    const parts = [`### ${subject ? `${head} · ${clipWidth(subject, 32)}` : head}`];
    if (body)
        parts.push("", RULE, "", body);
    if (extra)
        parts.push("", extra);
    if (foot)
        parts.push("", RULE, "", footLine(foot));
    return parts.join("\n");
}
// foot 是弱化的元信息：普通段整段包行内代码；含 `指令` 的引导段保持原样，仅指令为行内代码。
function footLine(foot) {
    return String(foot).split(" · ").map((seg) => (seg.includes("`") ? seg : "`" + seg + "`")).join(" · ");
}
function contextWindowLabel(value) {
    if (!value)
        return "未知";
    return value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : `${Math.round(value / 1000)}k`;
}
function kilo(n) {
    const v = Number(n);
    if (!isFinite(v))
        return String(n);
    if (v < 1000)
        return String(Math.round(v));
    if (v < 1000000)
        return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
    return `${(v / 1000000).toFixed(2)}M`;
}
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
function fmtSize(n) {
    return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`;
}
const durLabel = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
// 弹窗内容放进代码块：避免 `$...$` 被企微渲染成公式、Markdown 符号被解释。
function uiFence(text) {
    const body = truncateUtf8(stripCtrlKeepNl(String(text || "")).trim(), UI_TEXT_MAX_BYTES).replace(/`{3,}/g, "ʼʼʼ");
    return body ? "```\n" + body + "\n```" : "";
}
const splitTerms = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean);
function hayMatch(hay, terms) {
    for (const w of terms)
        if (!hay.includes(w))
            return false;
    return true;
}
// 相关性：会话名 > 用户输入；整句命中、前缀命中、越靠前、出现次数越多分越高。
const FIELD_WEIGHT = { name: 10, user: 4 };
function fieldScore(text, w) {
    const at = text.indexOf(w);
    if (at < 0)
        return 0;
    let n = 0;
    for (let i = at; i >= 0; i = text.indexOf(w, i + w.length))
        n++;
    return 1 + (at === 0 ? 1 : 0) + 1 / (1 + at / 20) + Math.min(n - 1, 3) * 0.2 + (text === w ? 2 : 0);
}
export function relevance(meta, terms, find) {
    const f = meta.fields || { name: "", user: meta.hay || "" };
    const phrase = find.toLowerCase().replace(/\s+/g, " ");
    let score = 0;
    for (const [k, weight] of Object.entries(FIELD_WEIGHT)) {
        const text = f[k] || "";
        if (!text)
            continue;
        for (const w of terms)
            score += weight * fieldScore(text, w);
        if (terms.length > 1 && text.includes(phrase))
            score += weight * 2;
    }
    return score;
}
/** session/list 条目 → 历史列表与检索用的元信息。 */
export function sessionMeta(s) {
    const name = oneLine(s.title || "");
    const user = Array.from(oneLine((s.prompts || []).join(" "))).slice(0, USER_HEAD_MAX).join("");
    const cut = (x) => Array.from(x).slice(0, HIST_NAME_MAX).join("");
    const fields = { name: name.toLowerCase(), user: user.toLowerCase() };
    return { name: cut(name) || cut(user) || "(未命名)", cwd: s.cwd || HOME, hay: [fields.name, fields.user].filter(Boolean).join(" "), fields };
}
function screenLocked() {
    if (process.platform !== "darwin")
        return Promise.resolve(false);
    return new Promise((res) => execFile("ioreg", ["-n", "Root", "-d1", "-r"], { timeout: 5000 }, (e, so) => {
        if (e)
            return res(false);
        res(/"IOConsoleLocked"\s*=\s*Yes/.test(String(so)));
    }));
}
class MediaFetchError extends Error {
}
let runSeq = 0;
export class Run {
    constructor() {
        this.id = `r${++runSeq}-${Date.now().toString(36)}`;
        this.startedAt = Date.now();
        this.assistantTexts = [];
        this.toolCalls = 0;
        this.tool = "";
        this.lastOutputAt = Date.now();
        this.error = null;
        this.aborted = null;
        this.stopRequestedAt = 0;
        this.local = false;
        this.begun = false;
        this.watched = false;
        this.muted = false;
        this.settled = false;
        this._waiters = [];
    }
    get lastText() {
        for (let i = this.assistantTexts.length - 1; i >= 0; i--) {
            if (this.assistantTexts[i].trim())
                return this.assistantTexts[i].trim();
        }
        return "";
    }
    wait() {
        if (this.settled)
            return Promise.resolve(this);
        return new Promise((res) => this._waiters.push(res));
    }
    settle() {
        if (this.settled)
            return;
        this.settled = true;
        this.endedAt = Date.now();
        const w = this._waiters;
        this._waiters = [];
        for (const r of w)
            r(this);
    }
}
/**
 * 一个遥控实例：企微传输 + 命令 + 卡片 + Run/Target 状态机。所有状态都在闭包里，重启即重建。
 * host 提供会话控制（见 lib/host/dsh-host.mjs），返回值里的 turnStart / output / turnEnd / uiAsk 等由它回调。
 */
export function createRemote({ host, dir, config, log: echo = () => { }, createTransport = null, onRestart = null, onConfigWritten = () => { } }) {
    const CFG = config;
    const DIR = dir;
    const LOG_FILE = path.join(DIR, "bridge.log");
    const CURRENT_FILE = path.join(DIR, ".current");
    const DEFAULT_PLACE_FILE = path.join(DIR, ".default-place");
    // 手机上发过消息的会话：它们的定时提醒 / 目标续跑轮次推回手机；跨重启保留。
    const PHONE_SESSIONS_FILE = path.join(DIR, "phone-sessions.json");
    const OUT_DIR = path.join(DIR, "out");
    const NAME_WAIT_MS = Number.isFinite(CFG.nameWaitMs) ? CFG.nameWaitMs : 10000;
    const RUN_PING_MS = Array.isArray(CFG.runPingMs) ? CFG.runPingMs : RUN_PING_DEFAULT;
    // 手机发起的任务里，审批转企微卡片；confirm 超时策略见 remoteConfirm。
    const UI_POLICY = CFG.remoteConfirm;
    const UI_TIMEOUT_MS = CFG.remoteConfirmTimeoutMs;
    const INBOX_DIR = expandPath(CFG.inboxDir);
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
    function log(line) {
        const rec = `[${ts()}] ${line}\n`;
        try {
            fs.appendFileSync(LOG_FILE, rec, { mode: 0o600 });
        }
        catch { }
        echo(line);
    }
    let transport;
    let stopped = false;
    let started = false;
    const timers = new Set();
    const later = (fn, ms) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        t.unref?.();
        timers.add(t);
        return t;
    };
    // Re-read on each lookup so hand edits of aliases.json apply without restarting.
    let lastAliases = {};
    function dirAliases() {
        try {
            lastAliases = loadAliases(DIR);
        }
        catch (e) {
            log(`目录别名表无效，沿用上次有效版本：${e.message}`);
        }
        return lastAliases;
    }
    // ---- 工作区：Desktop 侧栏的分组；会话只有带 workspaceId 创建才归入，否则在「未分组」 ----
    let wsState = { items: [], archived: new Set(), pinned: [] };
    async function refreshWorkspaces() {
        if (!host.workspaces)
            return wsState;
        try {
            wsState = await host.workspaces();
        }
        catch (e) {
            log(`workspace/follow 失败（沿用上次工作区）：${e?.message || e}`);
        }
        return wsState;
    }
    const workspaceOf = (sid) => wsState.items.find((w) => w.sessionIds.includes(sid)) || null;
    const isArchived = (sid) => wsState.archived.has(sid);
    const realDir = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const workspaceAt = (d) => { const r = realDir(d); return wsState.items.find((w) => w.path === r) || null; };
    /** 工作区名 / 「未分组」/ 目录别名 / ~ 或绝对路径 → 新建会话的位置；认不出返回 null。不是工作区的目录进「未分组」。 */
    function resolvePlace(arg) {
        const a = String(arg || "").trim();
        if (!a)
            return null;
        if (/^(未分组|ungrouped)$/i.test(a))
            return { ws: null, cwd: "" };
        const ws = wsState.items.find((w) => w.title.toLowerCase() === a.toLowerCase());
        if (ws)
            return { ws, cwd: ws.path };
        const mapped = dirAliases()[a.toLowerCase()];
        if (!mapped && !/^(~|\/)/.test(a))
            return null;
        const d = path.resolve(expandPath(mapped || a));
        try {
            if (!fs.statSync(d).isDirectory())
                return null;
        }
        catch {
            return null;
        }
        const at = workspaceAt(d);
        return at ? { ws: at, cwd: at.path, alias: mapped ? a.toLowerCase() : "" } : { ws: null, cwd: d, alias: mapped ? a.toLowerCase() : "" };
    }
    const placeName = (p) => (p.ws ? p.ws.title : p.cwd ? `未分组 · ${tilde(p.cwd)}` : "未分组");
    /** 会话所在位置：工作区名（分支），未分组时带上目录。 */
    function whereLabel(t) {
        const ws = workspaceOf(t.sessionId);
        return (ws ? ws.title : `未分组 · ${tilde(t.cwd)}`) + branchNote(t.cwd);
    }
    const whereShort = (t) => workspaceOf(t.sessionId)?.title || "未分组";
    // 归入工作区时目录可从工作区推出；未分组时目录是唯一的位置信息。
    const placeFacts = (t) => workspaceOf(t.sessionId)
        ? [{ keyname: "工作区", value: whereShort(t) }]
        : [{ keyname: "工作区", value: "未分组" }, { keyname: "目录", value: tilde(t.cwd) }];
    let phoneSessions = new Set();
    function loadPhoneSessions() {
        try {
            const v = JSON.parse(fs.readFileSync(PHONE_SESSIONS_FILE, "utf8"));
            phoneSessions = new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
        }
        catch {
            phoneSessions = new Set();
        }
    }
    function notePhoneSession(sid, phone) {
        if (!sid || phoneSessions.has(sid) === phone)
            return;
        if (phone)
            phoneSessions.add(sid);
        else
            phoneSessions.delete(sid);
        const keep = [...phoneSessions].slice(-200);
        phoneSessions = new Set(keep);
        try {
            fs.writeFileSync(PHONE_SESSIONS_FILE, JSON.stringify(keep), { mode: 0o600 });
        }
        catch (e) {
            log(`写 phone-sessions.json 失败：${e?.message || e}`);
        }
    }
    function sendText(text) { return transport.send(text); }
    async function uploadMdDoc({ name, cwd, body, meta = "" }) {
        const base = `${slugName(name)}-${stampNow()}-${crypto.randomUUID().slice(0, 8)}.md`;
        const file = path.join(OUT_DIR, base);
        const doc = `# ${stripCtrl(String(name || "DSH 会话"))}\n\n> ${[tilde(cwd || HOME), meta].filter(Boolean).join(" · ")}\n\n---\n\n${body}\n`;
        await fsp.writeFile(file, doc, { mode: 0o600 });
        return file;
    }
    async function pushResult(msg) {
        if (typeof msg === "string" || msg.card)
            return transport.send(msg);
        try {
            return await transport.send({ text: msg.text, file: msg.doc ? await uploadMdDoc(msg.doc) : undefined });
        }
        catch {
            return transport.send(msg.degrade ? msg.degrade() : "结果保存失败，请回到电脑查看会话。");
        }
    }
    async function fetchInboxFile(m) {
        const root = await fsp.realpath(INBOX_DIR);
        const local = await fsp.realpath(m.local);
        if (!local.startsWith(root + path.sep))
            throw new Error("附件不在收件目录");
        const stat = await fsp.stat(local);
        if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES)
            throw new Error("附件超限");
        return local;
    }
    async function composeWithMedia(raw, media) {
        if (!media?.length)
            return raw;
        const rs = await Promise.allSettled(media.map(fetchInboxFile));
        const bad = rs.find((r) => r.status === "rejected");
        if (bad) {
            const msg = bad.reason?.message || String(bad.reason);
            log(`附件拉取失败，整条未投递：${msg}`);
            throw new MediaFetchError(`附件拉取失败：${msg}`);
        }
        const paths = rs.map((r) => r.value);
        const notes = media.map((m, i) => m.kind === "image" ? `已收到图片：${paths[i]}（请先用 read_image 查看）` : `已收到文件：${paths[i]}（可用 read 查看）`);
        const lead = raw || "（见附件，请先查看）";
        return [lead, ...notes].join("\n\n");
    }
    function markAck(ack, queued) {
        if (ack && queued)
            ack.media = true;
    }
    async function deliverWithMedia(t, raw, media, ack) {
        let text;
        try {
            text = await composeWithMedia(raw, media);
        }
        catch (e) {
            if (e instanceof MediaFetchError)
                return fmtNotDelivered(t, e.message);
            throw e;
        }
        return deliverAndWait(t, text, ack);
    }
    let keySeq = 0;
    const targets = new Map();
    class Target {
        constructor(kind, { cwd, name, sessionId }) {
            this.key = `t${++keySeq}`;
            this.kind = kind;
            this.cwd = cwd || HOME;
            this.name = name || "";
            this.hint = "";
            this.sessionId = sessionId || "";
            this.model = "";
            this.modelProvider = "";
            this.ctxPercent = null;
            this.contextWindow = null;
            this.tokenUsage = null;
            this.lastActivity = Date.now();
            this.run = null;
            this.lastSettled = null;
            this.loops = new Map();
            this.closed = false;
            this.mtimeMs = Date.now();
            this.thinkingLevel = "";
        }
        get busy() {
            if (this.run && !this.run.settled)
                return true;
            for (const r of this.loops.values())
                if (!r.settled)
                    return true;
            return false;
        }
        noteSettled(run) {
            if (run)
                this.lastSettled = run;
        }
        trimLoops() {
            if (this.loops.size <= LOOPS_KEEP)
                return;
            for (const k of [...this.loops.keys()].slice(0, this.loops.size - LOOPS_KEEP)) {
                if (this.loops.get(k)?.settled)
                    this.loops.delete(k);
            }
        }
        label() {
            if (this.name)
                return this.name;
            if (this.hint)
                return this.hint;
            if (this.kind === "history")
                return "会话";
            return `新会话 · ${tilde(this.cwd)}`;
        }
    }
    /** DSH 会话。active = 宿主里 Agent 已加载或正在运行，只用于引用路由；「活跃会话」列表见 activeList。 */
    class DshTarget extends Target {
        constructor(opts) {
            super("dsh", opts);
            this.active = false;
            this.opened = false;
            this.running = false;
            this.sub = false;
            this.titleFinal = false;
            this.turnRun = null;
            this.art = freshArtifacts();
            this.artTracked = new Map();
            this.backfill = null;
        }
        applyInfo(s) {
            if (s.cwd)
                this.cwd = s.cwd;
            if (s.title && !this.titleFinal)
                this.name = oneLine(s.title);
            if (typeof s.running === "boolean")
                this.running = s.running;
            if (s.agentAvailable || s.running)
                this.active = true;
            else if (s.agentAvailable === false && !s.running)
                this.active = false;
            if (s.sub)
                this.sub = true;
            if (s.updatedAt > 0 && s.updatedAt > this.lastActivity)
                this.lastActivity = s.updatedAt;
        }
        applyProjections(v) {
            if (!v)
                return;
            if (typeof v.title === "string" && v.title)
                this.name = oneLine(v.title);
            if (typeof v.workingDirectory === "string" && v.workingDirectory)
                this.cwd = v.workingDirectory;
            const sel = v.modelSelection?.next || v.modelSelection?.lastUsed;
            if (sel?.model) {
                this.model = String(sel.model);
                this.modelProvider = String(sel.provider || "");
                this.thinkingLevel = sel.reasoningEffort ? String(sel.reasoningEffort) : "";
            }
            const cp = v.contextPressure;
            if (cp?.contextWindow > 0) {
                this.contextWindow = cp.contextWindow;
                this.ctxPercent = Number.isFinite(cp.pressureTokens) ? (cp.pressureTokens / cp.contextWindow) * 100 : null;
            }
            if (v.tokenUsage && typeof v.tokenUsage === "object")
                this.tokenUsage = v.tokenUsage;
            if (typeof v.permissions?.currentValue === "string")
                this.permission = v.permissions.currentValue;
            if ("goal" in v)
                this.goal = goalView(v.goal);
            this.projected = Number.isFinite(cp?.projectedTokens) ? cp.projectedTokens : Number.isFinite(cp?.pressureTokens) ? cp.pressureTokens : 0;
        }
        async refreshMeta() {
            try {
                this.applyProjections(await host.projections(this.sessionId));
            }
            catch (e) {
                log(`dsh[${this.key}] projections 失败（沿用上次信息）：${e?.message || e}`);
            }
            // 新会话跑完首轮前 modelSelection 投影为空，按部署默认模型显示。
            if (!this.model) {
                const d = await host.modelCatalog().then((c) => c?.default, () => null);
                if (d?.model) {
                    this.model = String(d.model);
                    this.modelProvider = String(d.provider || "");
                    this.thinkingLevel = d.reasoningEffort ? String(d.reasoningEffort) : "";
                }
            }
        }
        async stats() {
            await this.refreshMeta();
            return { contextUsage: { percent: this.ctxPercent, contextWindow: this.contextWindow } };
        }
        footer() {
            return this.stats();
        }
        async deliver(text, mode = "queue") {
            await unarchiveFor(this);
            const run = new Run();
            run.id = `${PHONE_RPC_PREFIX}${crypto.randomUUID()}`;
            this.loops.set(run.id, run);
            this.trimLoops();
            if (mode !== "steer" && (!this.run || this.run.settled))
                this.run = run;
            try {
                await host.prompt(this.sessionId, run.id, text, mode);
            }
            catch (e) {
                const error = String(e?.message || e);
                log(`dsh[${this.key}] prompt 失败：${error.slice(0, 160)}`);
                run.error = error;
                run.settle();
                return { run, queued: false, error };
            }
            this.opened = true;
            this.active = true;
            log(`deliver target=${this.key} id=${run.id}`);
            return { run, queued: true };
        }
        async abort() {
            try {
                await host.cancel(this.sessionId);
                return true;
            }
            catch (e) {
                log(`dsh[${this.key}] cancel 失败：${e?.message || e}`);
                return false;
            }
        }
        async listModels() {
            const cat = await host.modelCatalog();
            const routable = Array.isArray(cat?.routableProviders) ? new Set(cat.routableProviders) : null;
            const all = [];
            for (const g of cat?.groups || []) {
                if (!g?.id || (routable && !routable.has(g.id)))
                    continue;
                for (const m of g.models || []) {
                    if (!m?.id)
                        continue;
                    const out = { provider: stripCtrl(String(g.id)), id: stripCtrl(String(m.id)), efforts: (m.reasoning?.efforts || []).map((e) => String(e.id)).filter(Boolean), defaultEffort: m.reasoning?.defaultEffort || "" };
                    if (m.name && String(m.name) !== out.id)
                        out.name = stripCtrl(String(m.name));
                    all.push(out);
                }
            }
            return { models: all, all, scoped: false };
        }
        async setModel(m) {
            const keep = this.thinkingLevel && (m.efforts || []).includes(this.thinkingLevel) ? this.thinkingLevel : "";
            const sel = await host.selectModel(this.sessionId, { provider: m.provider, model: m.id, ...(keep ? { reasoningEffort: keep } : {}) });
            this.model = String(sel?.model || m.id);
            this.modelProvider = String(sel?.provider || m.provider);
            this.thinkingLevel = sel?.reasoningEffort ? String(sel.reasoningEffort) : "";
            return { ok: true };
        }
        /** 当前模型可选的思考强度；模型不支持推理时为空。 */
        async thinkingLevels() {
            await this.refreshMeta();
            const { all } = await this.listModels();
            const m = all.find((x) => x.id === this.model && (!this.modelProvider || x.provider === this.modelProvider));
            if (!m?.efforts?.length)
                return { levels: [], current: "" };
            return { levels: m.efforts, current: this.thinkingLevel || m.defaultEffort || "" };
        }
        async setThinking(level) {
            if (!this.model)
                await this.refreshMeta();
            const sel = await host.selectModel(this.sessionId, { provider: this.modelProvider, model: this.model, reasoningEffort: level });
            this.thinkingLevel = sel?.reasoningEffort ? String(sel.reasoningEffort) : level;
            return { ok: true, level: this.thinkingLevel };
        }
        async compact() {
            await this.refreshMeta();
            const before = this.projected || 0;
            const r = await host.compact(this.sessionId);
            if (r?.kind !== "success")
                return { ok: false, error: r?.text || "压缩失败" };
            await this.refreshMeta();
            return { ok: true, before, after: this.projected || 0, text: String(r.text || "") };
        }
        /** 插件启动前的产物：用 session/follow 首帧快照补扫一次。 */
        loadHistory() {
            this.backfill ||= (async () => {
                try {
                    for (const ev of await host.snapshot(this.sessionId))
                        ingestEvent(this.art, ev, this.cwd);
                }
                catch (e) {
                    log(`dsh[${this.key}] 产物补扫失败（只计插件启动后的产物）：${e?.message || e}`);
                }
            })();
            return this.backfill;
        }
        close(why = "会话已关闭") {
            this.closed = true;
            for (const r of new Set([...this.loops.values(), this.run].filter(Boolean))) {
                if (r.settled)
                    continue;
                if (shuttingDown)
                    r.aborted = shuttingDown;
                else
                    r.error = why;
                r.settle();
            }
            dropUiPrompts(this, { cancelled: true });
            targets.delete(this.key);
        }
    }
    /** 手机往 Desktop 里已归档的会话发消息：先取消归档，否则 DSH 会拦下这一轮。 */
    async function unarchiveFor(t) {
        if (!host.unarchive)
            return;
        await refreshWorkspaces();
        if (!isArchived(t.sessionId))
            return;
        try {
            await host.unarchive(t.sessionId);
            wsState.archived.delete(t.sessionId);
            log(`取消归档 target=${t.key}`);
            sendText(plainText({ head: "🗂️ 已取消归档", subject: t.label(), body: "这个会话在 Desktop 里已归档，已取消归档后投递。" }));
        }
        catch (e) {
            log(`取消归档失败 target=${t.key}：${e?.message || e}`);
        }
    }
    function targetBySid(sid) {
        if (!sid)
            return null;
        for (const t of targets.values())
            if (t.sessionId === sid && !t.closed)
                return t;
        return null;
    }
    /** 找到或登记一个会话。 */
    function ensureTarget(info) {
        let t = targetBySid(info.sessionId);
        if (!t) {
            t = new DshTarget({ cwd: info.cwd, name: info.title ? oneLine(info.title) : "", sessionId: info.sessionId });
            if (info.updatedAt > 0)
                t.lastActivity = info.updatedAt;
            targets.set(t.key, t);
            log(`register dsh ${t.key} cwd=${tilde(t.cwd)} id=${String(info.sessionId).slice(0, 16)}${info.sub ? " sub" : ""}`);
            if (currentSessionId && t.sessionId === currentSessionId)
                currentKey = t.key;
            if (!info.cwd)
                void syncSession(t);
        }
        t.applyInfo(info);
        return t;
    }
    /** 只从事件里知道 sessionId 的会话：补全目录、标题和 subagent 标记。 */
    async function syncSession(t) {
        try {
            const s = (await host.listSessions()).find((x) => x.sessionId === t.sessionId);
            if (s)
                t.applyInfo(s);
        }
        catch { }
    }
    const liveTarget = (t) => !!t && t.kind === "dsh" && !t.closed && (t.active || t.opened || t.busy || t.key === currentKey);
    const listedLive = (t) => liveTarget(t) && !t.sub && !isArchived(t.sessionId);
    /** 活跃列表顺序：置顶在前（按置顶顺序），其余按 Desktop 侧栏的工作区顺序分组、未分组最后，组内按最近活动。 */
    function liveOrder(a, b) {
        const pin = (t) => { const i = wsState.pinned.indexOf(t.sessionId); return i < 0 ? Infinity : i; };
        const grp = (t) => { const ws = workspaceOf(t.sessionId); const i = ws ? wsState.items.indexOf(ws) : -1; return i < 0 ? Infinity : i; };
        return pin(a) - pin(b) || grp(a) - grp(b) || b.lastActivity - a.lastActivity;
    }
    const recentInfo = (s, now) => s.updatedAt > 0 && now - s.updatedAt < ACTIVE_RECENT_MS;
    function activeList() {
        const now = Date.now();
        const sticky = (t) => t.busy || t.running || t.key === currentKey || wsState.pinned.includes(t.sessionId);
        const pool = [...targets.values()].filter((t) => t.kind === "dsh" && !t.closed && !t.sub && !isArchived(t.sessionId));
        const recent = pool.filter((t) => !sticky(t) && now - t.lastActivity < ACTIVE_RECENT_MS)
            .sort((a, b) => b.lastActivity - a.lastActivity).slice(0, ACTIVE_MAX);
        return [...pool.filter(sticky), ...recent].sort(liveOrder);
    }
    let shuttingDown = "";
    let lastPhoneAt = 0;
    let numMap = [];
    let histStat = { total: 0, matched: 0, find: "", includeSub: false };
    async function buildList(opts = {}) {
        const find = String(opts.find || "").trim();
        const terms = splitTerms(find);
        let sessions = [];
        const wsP = refreshWorkspaces();
        try {
            sessions = await host.listSessions();
        }
        catch (e) {
            log(`session/list 失败：${e?.message || e}`);
        }
        await wsP;
        const now = Date.now();
        for (const s of sessions) {
            const t = targetBySid(s.sessionId);
            if (t)
                t.applyInfo(s);
            else if ((s.running || recentInfo(s, now) || wsState.pinned.includes(s.sessionId)) && !s.sub && !s.blank && !isArchived(s.sessionId))
                ensureTarget(s);
        }
        const live = activeList();
        const liveIds = new Set(live.map((t) => t.sessionId));
        // 带关键词检索时活跃会话也参与，免得最近用过的会话搜不到。
        const all = sessions.filter((s) => (terms.length || !liveIds.has(s.sessionId)) && !s.blank).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        // 「全部」才显示 subagent 与 Desktop 里已归档的会话。
        const showSub = !!opts.includeSub;
        const pool = showSub ? all : all.filter((s) => !s.sub && !isArchived(s.sessionId));
        let hist = [];
        let matched = 0;
        if (!terms.length) {
            hist = pool.slice(0, HIST_LIST).map((s) => ({ s, meta: sessionMeta(s) }));
            matched = all.length;
        }
        else {
            const hits = [];
            for (const s of pool) {
                const meta = sessionMeta(s);
                if (!hayMatch(meta.hay, terms))
                    continue;
                hits.push({ s, meta, score: relevance(meta, terms, find) });
            }
            // 同分按最近修改排序。
            hits.sort((a, b) => b.score - a.score || (b.s.updatedAt || 0) - (a.s.updatedAt || 0));
            matched = hits.length;
            hist = hits.slice(0, HIST_FIND_MAX);
        }
        histStat = { total: all.length, matched, find, includeSub: showSub };
        const rows = [...live];
        for (const { s, meta } of hist) {
            const t = new Target("history", { cwd: meta.cwd, name: meta.name, sessionId: s.sessionId });
            t.mtimeMs = s.updatedAt || Date.now();
            rows.push(t);
        }
        numMap = rows;
        return numMap;
    }
    const liveRows = (rows) => rows.filter((t) => t.kind !== "history");
    const histRows = (rows) => rows.filter((t) => t.kind === "history");
    let currentKey = null;
    let currentSessionId = "";
    // 「取关」后电脑上发起的轮次不推送；只在内存，重启后恢复推送，宁可多推不漏推。
    let muted = false;
    // 「关注」后电脑发起的审批也转手机；「取关」清除。只在内存。
    let following = false;
    function loadCurrent() {
        try {
            currentSessionId = fs.readFileSync(CURRENT_FILE, "utf8").trim();
        }
        catch {
            currentSessionId = "";
        }
    }
    // 上次发消息或切换会话以来推送过的会话，最近的在前；不设有效期。
    let pushedKeys = [];
    const notePush = (t) => { pushedKeys = [t.key, ...pushedKeys.filter((k) => k !== t.key)]; };
    /** 推送过的非当前会话：此时不引用的普通消息容易发错，需先确认发给谁。 */
    function pushedOthers(cur) {
        return pushedKeys.map((k) => targets.get(k)).filter((t) => liveTarget(t) && t !== cur);
    }
    /** 手机上的切换动作；返回补推的待答问题数。 */
    function bindCurrent(t) {
        pushedKeys = [];
        currentKey = t?.key || null;
        let flushed = 0;
        if (t) {
            muted = false;
            watchInflight(t);
            flushed = flushParkedUi(t);
        }
        const sid = t?.sessionId || "";
        if (sid === currentSessionId)
            return flushed;
        currentSessionId = sid;
        try {
            if (sid)
                fs.writeFileSync(CURRENT_FILE, sid + "\n", { mode: 0o600 });
            else
                fs.rmSync(CURRENT_FILE, { force: true });
        }
        catch (e) {
            log(`写 .current 失败：${e?.message || e}`);
        }
        return flushed;
    }
    function inflightRuns(t) {
        const runs = new Set(t.loops ? [...t.loops.values()] : []);
        if (t.run)
            runs.add(t.run);
        return [...runs].filter((r) => !r.settled);
    }
    function watchInflight(t) {
        for (const r of inflightRuns(t)) {
            r.muted = false;
            if (r.watched)
                continue;
            watchAsync(t, r);
            log(`bind → watch inflight target=${t.key} id=${r.id} elapsed=${human(Date.now() - r.startedAt)}`);
        }
    }
    function currentTarget() {
        if (currentKey) {
            const t = targets.get(currentKey);
            if (t && !t.closed)
                return t;
        }
        if (currentSessionId) {
            const t = targetBySid(currentSessionId);
            if (t) {
                currentKey = t.key;
                return t;
            }
        }
        return null;
    }
    function renderList(subset, all, title, hint = "") {
        const lines = subset.map((t) => {
            const i = all.indexOf(t);
            const bits = [`${num(i + 1)} ${rowName(t)}`];
            if (t.busy)
                bits.push("运行中");
            bits.push(t.kind === "history" ? ago(t.mtimeMs) : ago(t.lastActivity));
            bits.push(whereShort(t));
            if (t.key === currentKey)
                bits.push("← 当前");
            return bits.join(" · ");
        });
        return plainText({
            head: "⚠️ 卡片发送失败",
            subject: title,
            body: lines.join("\n") || "（空）",
            foot: "发送 `选择会话 序号` 直达，如 `选择会话 2`" + hint,
        });
    }
    let taskSeq = 0;
    const taskId = (tag) => `task_${String(tag).replace(/[^0-9A-Za-z]/g, "")}_${Date.now()}${++taskSeq}`;
    function cardBlock(card, lead = "", fallback = "") {
        const clean = sanitizeCard(card);
        for (const option of card.options || []) {
            const pick = cardPicks.get(option.id);
            if (pick)
                pick.taskId = card.task_id;
        }
        const text = typeof fallback === "function" ? fallback() : String(fallback || lead);
        return { card: clean, fallback: text };
    }
    const cardPicks = new Map();
    function registerPick(info) {
        if (cardPicks.size > 600) {
            // 淘汰最旧的一批；仍在等待回答的弹窗卡片保留。
            for (const k of [...cardPicks.keys()].slice(0, 300))
                if (!(cardPicks.get(k)?.act === "ui" && uiPending.has(cardPicks.get(k).reqId)))
                    cardPicks.delete(k);
        }
        const key = `pb_${crypto.randomUUID()}`;
        cardPicks.set(key, { ...info, at: Date.now() });
        return key;
    }
    const usedTasks = new Map();
    function consumeTask(tid) {
        const now = Date.now();
        for (const [k, v] of usedTasks)
            if (now - v.at > CARD_TTL_MS)
                usedTasks.delete(k);
        if (!tid)
            return null;
        const hit = usedTasks.get(tid);
        if (hit)
            return hit;
        usedTasks.set(tid, { at: now, reply: "" });
        return null;
    }
    function pickState(t) {
        return t.busy ? "← 运行中" : "";
    }
    function emptyLiveText() {
        return plainText({
            head: "💬 活跃会话 · 0 个",
            body: "最近 24 小时没有用过的会话，可以新建一个，或者从历史里找。",
            foot: "发送 `创建会话` 新建，或 `历史会话` 找回会话",
        });
    }
    /** 列表里的会话名：置顶加 📌，已归档标出。 */
    function rowName(t) {
        const pre = wsState.pinned.includes(t.sessionId) ? "📌 " : "";
        return `${pre}${t.label()}${isArchived(t.sessionId) ? "（已归档）" : ""}`;
    }
    function optText(t) {
        const bits = [rowName(t), whereShort(t)];
        const st = pickState(t);
        if (st)
            bits.push(st);
        if (t.key === currentKey)
            bits.push("← 当前");
        return bits.join(" · ");
    }
    const selOpt = (t) => ({
        id: registerPick({
            act: "sel",
            targetKey: t.key,
            sessionId: t.sessionId,
            cwd: t.cwd,
            name: t.name,
            find: histStat.find || "",
            includeSub: !!histStat.includeSub,
        }),
        text: optText(t),
    });
    const PICK_LEAD = "**请选择会话**";
    function buildLsCard(rows) {
        const live = liveRows(rows);
        if (!live.length)
            return emptyLiveText();
        const options = live.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
        const card = {
            card_type: "vote_interaction",
            title: clip("💬 活跃会话", 26),
            desc: `活跃 ${live.length} 个 · 发「历史会话」查询历史`,
            options,
            mode: 0,
            submit_text: "选择会话",
            task_id: taskId("ls"),
        };
        return cardBlock(card, PICK_LEAD, () => renderList(live, rows, "活跃会话"));
    }
    function buildHistCard(rows) {
        const hist = histRows(rows);
        const { total, matched, find } = histStat;
        if (find && !hist.length) {
            return plainText({
                head: "🔍 历史检索",
                subject: `“${clip(find, 16)}”`,
                body: "没有找到。只搜会话名和你发过的消息，不搜回复。",
                foot: `已搜 ${total} 个 · 换个词，或发 \`历史会话\` 看最近 ${HIST_LIST} 条`,
            });
        }
        if (!hist.length) {
            return plainText({
                head: "🗂️ 历史会话 · 0 个",
                body: "还没有历史会话。",
                foot: "发送 `创建会话` 新建",
            });
        }
        const options = hist.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
        const card = {
            card_type: "vote_interaction",
            title: clip(find ? `🔍 “${find}” 的检索结果` : "🗂️ 历史会话", 26),
            desc: find ? `找到 ${matched} 个 · 显示 ${options.length} 个` : `最近 ${options.length} 个 · 发「历史会话 关键词」搜索`,
            options,
            mode: 0,
            submit_text: "选择会话",
            task_id: taskId("h"),
        };
        if (find && matched > options.length)
            log(`历史会话 检索 “${find}” 命中 ${matched} 条，列前 ${options.length}`);
        return cardBlock(card, PICK_LEAD, () => renderList(hist, rows, find ? `检索“${find}”` : "历史会话", find ? "" : " · 发 `历史会话 关键词` 搜索"));
    }
    function doneFoot(t, run, stats) {
        const foot = [`工作区：${whereLabel(t)}`, `运行：${human((run.endedAt || Date.now()) - run.startedAt)}`];
        const context = contextPctLabel(t, stats);
        if (context !== "未知")
            foot.push(`上下文：${context}`);
        return foot.join(" · ");
    }
    function ctxPercent(t, stats) {
        const fromStats = stats?.contextUsage?.percent;
        if (typeof fromStats === "number" && isFinite(fromStats))
            return fromStats;
        if (typeof t?.ctxPercent === "number" && isFinite(t.ctxPercent) && t.ctxPercent >= 0)
            return t.ctxPercent;
        return null;
    }
    function contextWindow(stats, t) {
        const value = stats?.contextUsage?.contextWindow || t?.contextWindow;
        return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
    }
    function contextLabel(t, stats) {
        const pct = ctxPercent(t, stats);
        const window = contextWindowLabel(contextWindow(stats, t));
        return pct == null ? (window === "未知" ? "未知" : `未知 / ${window}`) : `${pct.toFixed(1)}% / ${window}`;
    }
    // 三段式文本 foot 只保留百分比，窗口大小留给卡片展示。
    function contextPctLabel(t, stats) {
        const pct = ctxPercent(t, stats);
        return pct == null ? "未知" : `${pct.toFixed(1)}%`;
    }
    function fmtDone(t, run, stats) {
        const g = run.goalHead ? run.goal : null;
        const foot = doneFoot(t, run, stats) + (g ? ` · 目标：${g.roundsStarted}/${g.maxGoalRounds} 轮` : "");
        const hint = artHint(t);
        const reason = g?.blockedReason?.message && g.blockedReason.code !== "round-limit" ? `受阻原因：${g.blockedReason.message}\n\n` : "";
        const body = (reason + (run.lastText || "（无文本输出）")).trim();
        const bodyFull = body + hint;
        const state = run.stopped ? "⚠️ 已中断" : run.goalHead || (run.trigger === "schedule" ? "⏰ 定时任务完成" : run.trigger === "goal" ? "🎯 目标续跑完成" : "🏁 任务完成");
        const head = state;
        const subject = t.label();
        const full = plainText({ head, subject, body: bodyFull, foot });
        const fullBytes = Buffer.byteLength(full);
        if (fullBytes <= PUSH_TEXT_MAX_BYTES)
            return full;
        const note = `字数超限，请查看 Markdown。`;
        log(`交付正文 ${fullBytes} UTF-8 字节 > ${PUSH_TEXT_MAX_BYTES} → 转 Markdown 文档`);
        return {
            text: plainText({ head, subject, body: note + hint, foot }),
            doc: {
                name: t.label(),
                cwd: t.cwd,
                meta: `${human((run.endedAt || Date.now()) - run.startedAt)} · ${body.length} 字`,
                body,
            },
            degrade: () => plainText({
                head,
                subject,
                body: `${truncateUtf8(body, PUSH_TEXT_MAX_BYTES - 400)}\n\n…（共 ${body.length} 字，Markdown 文档上传失败，已截断）${hint}`,
                foot,
            }),
        };
    }
    function stateCard({ tag, icon, title, desc, emph, emphMax = EMPH_MAX, body = "", facts = [], lead = "", fallback }) {
        const hc = facts
            .filter(Boolean)
            .slice(0, 6)
            .map((f) => ({ keyname: clip(f.keyname, 5), value: clip(f.value, 26) }));
        const card = {
            card_type: "text_notice",
            main_title: { title: clip(icon ? `${icon} ${title}` : title, 26), desc: clip(desc, 30) },
            card_action: { type: 1, url: "https://work.weixin.qq.com" },
            task_id: taskId(tag),
        };
        if (emph) {
            card.emphasis_content = { title: clip(emph.title, emphMax) };
            if (emph.desc)
                card.emphasis_content.desc = clip(emph.desc, EMPH_DESC_MAX);
        }
        if (body)
            card.sub_title_text = clip(body, CARD_BODY_MAX);
        if (hc.length)
            card.horizontal_content_list = hc;
        return cardBlock(card, lead, fallback);
    }
    const runFor = (run) => human((run.endedAt || Date.now()) - run.startedAt);
    function fmtAccepted(t, text = "", behind = false) {
        const foot = [`工作区：${whereLabel(t)}`];
        if (t.model)
            foot.push(`模型：${t.model}`);
        const status = behind ? "已排队在此轮任务之后，完成后发送\n\n要并入这一轮，可发送 `插话 内容`" : "已送达，完成后推送";
        return plainText({ head: "⏳ 运行中", subject: t.label(), body: (text ? `> ${clipWidth(text, 40)}\n\n\u3000\n\n` : "") + status, foot: foot.join(" · ") });
    }
    function fmtFail(t, run) {
        return plainText({
            head: "⚠️ 任务失败",
            subject: t.label(),
            body: `错误：${run.error}`,
            foot: `工作区：${whereLabel(t)} · 运行：${runFor(run)}`,
        });
    }
    function fmtAborted(t, run) {
        return plainText({
            head: "⚠️ 任务中断",
            subject: t.label(),
            body: `${run.aborted}，这一轮的结果没能送回。电脑上的任务可能已经完成。`,
            foot: `工作区：${whereLabel(t)} · 运行：${runFor(run)} · 发送 \`状态\` 查看`,
        });
    }
    function fmtNotDelivered(t, error) {
        return plainText({
            head: "⚠️ 未送达",
            subject: t.label(),
            body: "这条消息没有进入会话，附件已保留。请重发。" + (error ? `\n\n原因：${String(error).slice(0, 60)}` : ""),
            foot: `工作区：${whereLabel(t)}`,
        });
    }
    async function deliverAndWait(t, text, ack) {
        pushedKeys = [];
        t.lastActivity = Date.now();
        if (!t.name)
            t.hint = promptHint(text);
        const behind = t.busy || t.running;
        const { run, queued, error } = await t.deliver(text);
        markAck(ack, queued);
        if (!queued)
            return fmtNotDelivered(t, error);
        const which = await Promise.race([run.wait().then(() => "DONE"), delay(SYNC_WINDOW_MS).then(() => "TIMEOUT")]);
        if (which === "DONE") {
            if (run.watched || run.superseded)
                return fmtAccepted(t, text, behind);
            if (run.aborted)
                return fmtAborted(t, run);
            if (run.error)
                return fmtFail(t, run);
            const stats = await t.stats();
            const msg = fmtDone(t, run, stats);
            if (typeof msg !== "string" && msg.doc) {
                try {
                    return { text: msg.text, file: await uploadMdDoc(msg.doc) };
                }
                catch {
                    return msg.degrade();
                }
            }
            return msg;
        }
        watchAsync(t, run);
        return fmtAccepted(t, text, behind);
    }
    async function deliverAsync(t, text, ack) {
        t.lastActivity = Date.now();
        if (!t.name)
            t.hint = promptHint(text);
        const { run, queued, error } = await t.deliver(text);
        markAck(ack, queued);
        if (!queued)
            return { notDelivered: true, error };
        return watchAsync(t, run);
    }
    const inflightPushes = new Set();
    function trackedPush(msg) {
        const p = pushResult(msg).finally(() => inflightPushes.delete(p));
        inflightPushes.add(p);
        return p;
    }
    const toolLabel = (name) => (name === "agent" || name === "Agent" ? "等待 subagent" : name);
    function watchAsync(t, run) {
        if (run.watched)
            return;
        run.watched = true;
        let sent = 0;
        const prog = setInterval(() => {
            if (run.settled || sent >= RUN_PING_MS.length)
                return clearInterval(prog);
            if (run.stopped || run.stopRequestedAt || run.muted || run.trigger === "goal")
                return;
            const ran = Date.now() - run.startedAt;
            if (ran < RUN_PING_MS[sent])
                return;
            // 关注接管的任务可能早已跑过好几档：只推一条，跳过已过的档位。
            while (sent < RUN_PING_MS.length && ran >= RUN_PING_MS[sent])
                sent++;
            const body = `已运行 ${human(ran)}，仍在运行中。` + (run.tool ? `\n\n当前动作：${toolLabel(run.tool)}` : "");
            notePush(t);
            sendText(plainText({ head: "⏳ 运行中", subject: t.label(), body, foot: "发送 `状态` 查看详情，或 `停止` 停止" }));
        }, Math.min(30000, RUN_PING_MS[0] || 30000));
        prog.unref?.();
        run.wait().then(async () => {
            clearInterval(prog);
            if (run.superseded)
                return;
            if (run.trigger === "goal" && !(await goalRoundDone(t, run)))
                return;
            await pushSettled(t, run);
        });
    }
    /** 目标续跑的一轮：目标还要继续就先不推，压下这一轮，等目标结束时连同结果推一次。 */
    async function goalRoundDone(t, run) {
        if (run.aborted || run.error || run.stopped) {
            t.goalHeld = null;
            return true;
        }
        if (goalLive(run.goalAtEnd)) {
            t.goalHeld = run;
            log(`goal round held target=${t.key} ${run.goalAtEnd ? goalLine(run.goalAtEnd) : "状态未知"}`);
            return false;
        }
        t.goalHeld = null;
        markGoalEnd(run, run.goalAtEnd);
        return true;
    }
    function markGoalEnd(run, g) {
        run.goal = g ? { ...g } : null;
        run.goalHead = goalEndHead(g);
    }
    async function pushSettled(t, run) {
        if (run.muted) {
            log(`async muted target=${t.key} dur=${human((run.endedAt || Date.now()) - run.startedAt)}（已取关，不推送）`);
            return;
        }
        // 用户主动「停止」且没有任何文本产出：「停止」的即时回复已说明，不再推一条「（无文本输出）」。
        if (run.stopByCmd && !run.aborted)
            run.error = "";
        if (run.stopByCmd && !run.error && !run.lastText && !run.aborted) {
            log(`async stopped-empty target=${t.key} dur=${human((run.endedAt || Date.now()) - run.startedAt)}（不推送）`);
            return;
        }
        const msg = run.aborted
            ? fmtAborted(t, run)
            : run.error
                ? fmtFail(t, run)
                : fmtDone(t, run, shuttingDown ? null : await t.stats?.().catch(() => null));
        const kind = run.aborted ? "aborted" : run.error ? "fail" : "done";
        const shaOf = typeof msg === "string" ? msg : msg.text;
        log(`async ${kind} sha=${sha8(shaOf)} target=${t.key} dur=${human((run.endedAt || Date.now()) - run.startedAt)}` +
            (typeof msg === "string" ? "" : " +md"));
        notePush(t);
        await trackedPush(msg);
    }
    /** 正在跑的轮次：优先当前 turn，其次最近一个未结束的 loop。 */
    function pendingRun(t) {
        if (t.turnRun && !t.turnRun.settled)
            return t.turnRun;
        if (t.run && !t.run.settled)
            return t.run;
        return [...(t.loops?.values?.() || [])].reverse().find((r) => !r.settled) || null;
    }
    function settleLost(t, run, why = "会话失联") {
        run.aborted = why;
        run.settle();
        t.noteSettled?.(run);
        if (!run.watched)
            log(`lost target=${t.key} id=${run.id} ${why}${run.local ? "（电脑轮次，未关注）" : ""}`);
    }
    const COMMANDS = new Set(["ls", "h", "n", "nb", "stop", "status", "help", "model", "cd", "think", "compact", "restart", "art", "remote", "mute", "steer", "perm", "goal", "recap"]);
    const NL_ALIASES = [
        ["帮助", "help", false],
        ["活跃会话", "ls", false],
        ["查询活跃会话", "ls", false],
        ["切换会话", "ls", false],
        ["历史会话", "h", true],
        ["查询历史会话", "h", true],
        ["创建会话", "n", true],
        ["新建会话", "n", true],
        ["创建后台会话", "nb", true],
        ["新建后台会话", "nb", true],
        ["状态", "status", false],
        ["查询状态", "status", false],
        ["停止", "stop", false],
        ["停止任务", "stop", false],
        ["切换模型", "model", true],
        ["模型", "model", true],
        ["切换目录", "cd", true],
        ["目录", "cd", true],
        ["切换工作区", "cd", true],
        ["工作区", "cd", true],
        ["插话", "steer", true],
        ["目标", "goal", true],
        ["切换权限模式", "perm", true],
        ["权限模式", "perm", true],
        ["切换权限", "perm", true],
        ["权限", "perm", false],
        ["切换思考强度", "think", true],
        ["思考强度", "think", true],
        ["压缩会话", "compact", true],
        ["压缩", "compact", true],
        ["重启服务", "restart", true],
        ["重启", "restart", true],
        ["产物", "art", false],
        ["查看产物", "art", false],
        ["回顾", "recap", false],
        ["关注", "remote", false],
        ["取消关注", "mute", false],
        ["取关", "mute", false],
        ["静音", "mute", false],
    ].sort((a, b) => b[0].length - a[0].length);
    function parseNlAlias(body) {
        for (const [word, cmd, args] of NL_ALIASES) {
            if (!body.startsWith(word))
                continue;
            const tail = body.slice(word.length);
            if (!tail)
                return { cmd, rest: "", alias: word };
            if (!args || !/^\s/.test(tail))
                continue;
            return { cmd, rest: tail.trim(), alias: word };
        }
        return null;
    }
    const BARE_ARGS = new Set(["h", "n", "nb", "model", "cd", "think", "compact", "restart", "steer", "perm", "goal"]);
    function parseBare(t) {
        const m = t.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
        if (!m)
            return null;
        const cmd = m[1].toLowerCase();
        if (!COMMANDS.has(cmd))
            return null;
        const rest = (m[2] || "").trim();
        if (rest && !BARE_ARGS.has(cmd))
            return null;
        return { cmd, rest, bare: true };
    }
    function parseCmd(text) {
        const t = text.trim();
        const selection = t.match(/^(?:选择会话|select)\s+(\d+)(?:\s+([\s\S]*))?$/i);
        if (selection)
            return { cmd: selection[1], rest: (selection[2] || "").trim(), alias: "选择会话" };
        const nl = parseNlAlias(t);
        if (nl)
            return nl;
        return parseBare(t);
    }
    const helpText = () => [
        "**📖 命令表**",
        "",
        "---",
        "",
        "| 英文 | 中文 |",
        "|---|---|",
        "| n | 创建会话 |",
        "| ls | 活跃会话 |",
        "| remote / mute | 关注 / 取关 |",
        "| perm | 权限模式 |",
        "| cd | 工作区 |",
        "| goal | 目标 |",
        "| model | 模型 |",
        "| think | 思考强度 |",
        "| compact | 压缩 |",
        "| recap | 回顾 |",
        "| status | 状态 |",
        "| stop | 停止 |",
        "| help | 帮助 |",
        "",
        "",
        "---",
        "",
        "**Tips**",
        "",
        "> 1. 电脑端在「设置→企微远程」中设置",
        "> 2. 先发附件，5 分钟内补文字一并发送",
        "> 3. 引用消息，可发送回复给相应会话",
    ].join("\n");
    async function openTarget(t) {
        t.opened = true;
        t.lastActivity = Date.now();
        await t.refreshMeta();
        void t.loadHistory();
    }
    async function resolveNumber(n) {
        if (!numMap.length)
            await buildList();
        const row = numMap[n - 1];
        if (!row)
            return null;
        if (row.kind !== "history")
            return row;
        let t = targetBySid(row.sessionId);
        if (!t) {
            t = new DshTarget({ cwd: row.cwd, name: row.name, sessionId: row.sessionId });
            targets.set(t.key, t);
            log(`open history target ${t.key} id=${row.sessionId.slice(0, 16)}`);
        }
        await openTarget(t);
        const i = numMap.indexOf(row);
        if (i >= 0)
            numMap[i] = t;
        return t;
    }
    // ---- 模型切换 ----
    const modelKey = (m) => `${m.provider}/${m.id}`;
    const modelLabel = (m) => m.name || m.id;
    const isCurrentModel = (t, m) => m.id === t.model && (!t.modelProvider || m.provider === t.modelProvider);
    function modelMatches(models, find) {
        const terms = String(find || "").toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length)
            return models;
        const exact = models.filter((m) => [m.id, modelKey(m), m.name || ""].some((x) => x.toLowerCase() === terms.join(" ")));
        if (exact.length)
            return exact;
        return models.filter((m) => hayMatch(`${modelKey(m)} ${m.name || ""}`.toLowerCase(), terms));
    }
    async function buildModelCard(t, find = "") {
        let models, all;
        try {
            await t.refreshMeta();
            ({ models, all } = await t.listModels());
        }
        catch (e) {
            return plainText({ head: "⚠️ 读取模型失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试，或发送 `状态` 查看" });
        }
        if (!models?.length && !all?.length) {
            return plainText({
                head: "⚠️ 没有可选模型",
                body: "DeepSeek Harness 里还没有配好可用的模型。",
                foot: "在电脑 Desktop 的设置里配置模型",
            });
        }
        const hits = find ? modelMatches(all, find) : models;
        if (find && !hits.length) {
            return plainText({
                head: "🔍 没有匹配的模型",
                subject: `“${clip(find, 16)}”`,
                body: `共 ${all.length} 个可用模型，没有找到包含该关键词的模型。`,
                foot: "发送 `模型` 查看全部",
            });
        }
        if (find && hits.length === 1)
            return applyModel(t, hits[0]);
        const shown = hits.slice(0, VOTE_OPT_MAX);
        const options = shown.map((m) => ({
            id: registerPick({ act: "model", targetKey: t.key, sessionId: t.sessionId, provider: m.provider, modelId: m.id }),
            text: [modelLabel(m), m.provider, isCurrentModel(t, m) ? "← 当前" : ""].filter(Boolean).join(" · "),
        }));
        const more = hits.length > shown.length ? ` · 显示前 ${shown.length} 个` : "";
        const card = {
            card_type: "vote_interaction",
            title: clip(`💡 切换模型 · ${t.label()}`, 26),
            desc: find ? `找到 ${hits.length} 个${more}` : `可选 ${hits.length} 个${more} · 发「模型 关键词」筛选`,
            options,
            mode: 0,
            submit_text: "切换模型",
            task_id: taskId("model"),
        };
        return cardBlock(card, "**请选择模型**", () => plainText({
            head: "⚠️ 卡片发送失败",
            subject: "切换模型",
            body: shown.map((m) => `${modelLabel(m)} · ${m.provider}${isCurrentModel(t, m) ? " · ← 当前" : ""}`).join("\n"),
            foot: "发送 `模型 模型名` 直接切换",
        }));
    }
    async function applyModel(t, m) {
        const fail = (why) => plainText({ head: "⚠️ 切换模型失败", subject: `${modelLabel(m)} · ${t.label()}`, body: `原因：${String(why || "未知").slice(0, 80)}`, foot: "发送 `模型` 重试" });
        let r;
        try {
            r = await t.setModel(m);
        }
        catch (e) {
            return fail(e?.message || e);
        }
        if (!r?.ok)
            return fail(r?.error);
        log(`切换模型 target=${t.key} → ${modelKey(m)}`);
        return buildModelCardDone(t, m);
    }
    function buildModelCardDone(t, m) {
        const name = modelLabel(m);
        const facts = [
            { keyname: "会话", value: t.label() },
            { keyname: "提供方", value: m.provider },
            { keyname: "思考强度", value: t.thinkingLevel || "默认" },
        ];
        return stateCard({
            tag: "model",
            icon: "💡",
            title: "切换模型",
            desc: t.busy ? "已切换，当前任务的后续请求生效" : "已切换，下一条消息生效",
            emph: { title: name },
            emphMax: EMPH_NAME_MAX,
            facts,
            fallback: () => plainText({ head: "💡 切换模型", subject: name, foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
        });
    }
    /** 卡片点选时找回会话：key 失效则按 sessionId 找。 */
    function pickTarget(pick) {
        let t = targets.get(pick.targetKey);
        if (!t || t.closed)
            t = targetBySid(pick.sessionId);
        return t || null;
    }
    async function handleModelPick(pick) {
        const t = pickTarget(pick);
        if (!t)
            return plainText({ head: "⚠️ 切换模型失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
        const { all: models = [] } = await t.listModels().catch(() => ({}));
        const m = models.find((x) => x.provider === pick.provider && x.id === pick.modelId) || { provider: pick.provider, id: pick.modelId };
        return applyModel(t, m);
    }
    // ---- 思考强度 ----
    const THINK_CN = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
    const thinkLabel = (l) => (THINK_CN[l] ? `${l} · ${THINK_CN[l]}` : l);
    /** 接受英文级别或中文说法（高 / 关闭…）。 */
    function thinkArg(arg) {
        const a = arg.trim().toLowerCase();
        return Object.hasOwn(THINK_CN, a) ? a : Object.keys(THINK_CN).find((k) => THINK_CN[k] === arg.trim()) || a;
    }
    async function buildThinkCard(t, arg = "") {
        let levels, current;
        try {
            ({ levels, current } = await t.thinkingLevels());
        }
        catch (e) {
            return plainText({ head: "⚠️ 读取思考强度失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试，或发送 `状态` 查看" });
        }
        if (!levels?.length) {
            return plainText({ head: "🧠 当前模型不支持思考强度", subject: `${t.model || "未知模型"} · ${t.label()}`, foot: "发送 `模型` 换一个支持推理的模型" });
        }
        if (arg) {
            const want = thinkArg(arg);
            if (!want || !levels.includes(want))
                return plainText({ head: "⚠️ 切换思考强度失败", body: `当前模型不支持：${clip(arg, 20)}\n\n可选：${levels.join(" / ")}` });
            return applyThinking(t, want);
        }
        const options = levels.slice(0, VOTE_OPT_MAX).map((l) => ({
            id: registerPick({ act: "think", targetKey: t.key, sessionId: t.sessionId, level: l }),
            text: [thinkLabel(l), l === current ? "← 当前" : ""].filter(Boolean).join(" · "),
        }));
        const sample = levels.find((l) => l !== current && l !== "off") || levels.find((l) => l !== current) || levels[0];
        const card = {
            card_type: "vote_interaction",
            title: clip(`🧠 切换思考强度 · ${t.label()}`, 26),
            desc: clip(`当前 ${current || "未知"} · 发「思考强度 ${sample}」直接切换`, 30),
            options,
            mode: 0,
            submit_text: "切换思考强度",
            task_id: taskId("think"),
        };
        return cardBlock(card, "**请选择思考强度**", () => plainText({
            head: "⚠️ 卡片发送失败",
            subject: "切换思考强度",
            body: levels.map((l) => `${thinkLabel(l)}${l === current ? " · ← 当前" : ""}`).join("\n"),
            foot: `发送 \`思考强度 ${sample}\` 直接切换`,
        }));
    }
    async function compactCard(t, instructions) {
        const fail = (why) => plainText({ head: "⚠️ 压缩会话失败", subject: t.label(), body: `原因：${String(why || "未知").slice(0, 80)}` });
        if (t.busy)
            return fail("会话正在运行，请等任务结束或先 `停止`");
        let r;
        try {
            r = await t.compact();
        }
        catch (e) {
            r = { ok: false, error: e?.message || String(e) };
        }
        if (!r?.ok) {
            if (/nothing to compact|too (small|short)|already compacted|no (history|messages)/i.test(String(r?.error)))
                return plainText({ head: "ℹ️ 无需压缩", subject: t.label(), body: "会话还很短，或刚压缩过，暂时没有可压缩的内容" });
            return fail(r?.error);
        }
        log(`压缩会话 target=${t.key} ${r.before}→${r.after}`);
        const facts = [{ keyname: "会话", value: t.label() }];
        if (r.text)
            facts.push({ keyname: "结果", value: r.text });
        const change = r.before && r.after ? `${fmtTok(r.before)} → ${fmtTok(r.after)}` : "已压缩";
        // DSH 的 /compact 不接受参数：带说明时照常压缩，并告知说明未生效。
        const desc = instructions ? "已压缩 · DSH 不支持指定重点，已按默认压缩" : "已压缩，下一条消息生效";
        return stateCard({
            tag: "compact",
            icon: "🗜️",
            title: "压缩会话",
            desc,
            emph: { title: change },
            emphMax: EMPH_NAME_MAX,
            facts,
            fallback: () => plainText({ head: "🗜️ 压缩会话", subject: t.label(), body: change, foot: desc }),
        });
    }
    async function applyThinking(t, level) {
        const fail = (why) => plainText({ head: "⚠️ 切换思考强度失败", subject: `${level} · ${t.label()}`, body: `原因：${String(why || "未知").slice(0, 80)}`, foot: "发送 `思考强度` 重试" });
        let r;
        try {
            r = await t.setThinking(level);
        }
        catch (e) {
            return fail(e?.message || e);
        }
        if (!r?.ok)
            return fail(r?.error);
        const got = r.level || level;
        log(`切换思考强度 target=${t.key} → ${got}${got !== level ? `（请求 ${level}）` : ""}`);
        const facts = [
            { keyname: "会话", value: t.label() },
            { keyname: "模型", value: t.model || "未知" },
        ];
        return stateCard({
            tag: "think",
            icon: "🧠",
            title: "切换思考强度",
            desc: got !== level ? `模型不支持 ${level}，已调整为 ${got}` : t.busy ? "已切换，当前任务的后续请求生效" : "已切换，下一条消息生效",
            emph: { title: thinkLabel(got) },
            emphMax: EMPH_NAME_MAX,
            facts,
            fallback: () => plainText({ head: "🧠 切换思考强度", subject: thinkLabel(got), foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
        });
    }
    function handleThinkPick(pick) {
        const t = pickTarget(pick);
        if (!t)
            return plainText({ head: "⚠️ 切换思考强度失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
        return applyThinking(t, pick.level);
    }
    // ---- 权限预设：DSH 的 /permission，只改当前会话 ----
    async function buildPermCard(t, arg = "") {
        let presets;
        try {
            await t.refreshMeta();
            presets = host.permissionCatalog ? await host.permissionCatalog() : [];
        }
        catch (e) {
            return plainText({ head: "⚠️ 读取权限模式失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试" });
        }
        if (!presets.length)
            return plainText({ head: "⚠️ 没有权限模式", body: "当前 DeepSeek Harness 没有提供可切换的权限模式。" });
        const cur = t.permission || "";
        const label = (p) => (p.name && p.name !== p.value ? `${p.name}（${p.value}）` : p.value);
        if (arg) {
            const a = arg.trim().toLowerCase();
            const hit = presets.find((p) => p.value.toLowerCase() === a || p.name.toLowerCase() === a)
                || (presets.filter((p) => p.value.toLowerCase().includes(a)).length === 1 ? presets.find((p) => p.value.toLowerCase().includes(a)) : null);
            if (!hit)
                return plainText({ head: "⚠️ 切换权限模式失败", body: `没有这个预设：${clip(arg, 20)}\n\n可选：${presets.map((p) => p.value).join(" / ")}` });
            return applyPermission(t, hit.value);
        }
        const options = presets.slice(0, VOTE_OPT_MAX).map((p) => ({
            id: registerPick({ act: "perm", targetKey: t.key, sessionId: t.sessionId, preset: p.value }),
            text: [label(p), p.value === cur ? "← 当前" : ""].filter(Boolean).join(" · "),
        }));
        const card = {
            card_type: "vote_interaction",
            title: clip(`🔐 切换权限模式 · ${t.label()}`, 26),
            desc: clip(`当前 ${cur || "未知"} · 只影响这个会话`, 30),
            options,
            mode: 0,
            submit_text: "切换权限模式",
            task_id: taskId("perm"),
        };
        return cardBlock(card, "**请选择权限模式**", () => plainText({
            head: "⚠️ 卡片发送失败",
            subject: "切换权限模式",
            body: presets.map((p) => `${label(p)}${p.value === cur ? " · ← 当前" : ""}`).join("\n"),
            foot: "发送 `权限模式 模式名` 直接切换",
        }));
    }
    async function applyPermission(t, preset) {
        const fail = (why) => plainText({ head: "⚠️ 切换权限模式失败", subject: `${preset} · ${t.label()}`, body: `原因：${String(why || "未知").slice(0, 80)}`, foot: "发送 `权限模式` 重试" });
        let r;
        try {
            r = await host.setPermission(t.sessionId, preset);
        }
        catch (e) {
            return fail(e?.message || e);
        }
        if (r?.kind !== "success")
            return fail(r?.text);
        await t.refreshMeta();
        log(`切换权限 target=${t.key} → ${preset}`);
        return stateCard({
            tag: "perm",
            icon: "🔐",
            title: "切换权限模式",
            desc: t.busy ? "已切换，当前任务的后续操作生效" : "已切换，只影响这个会话",
            emph: { title: t.permission || preset },
            emphMax: EMPH_NAME_MAX,
            facts: [{ keyname: "会话", value: t.label() }],
            fallback: () => plainText({ head: "🔐 切换权限模式", subject: t.permission || preset, foot: `会话：${t.label()}` }),
        });
    }
    // ---- 目标：DSH 的 /goal，模型在同一会话里自动续跑到完成；中间各轮不推，结束时推一次 ----
    const GOAL_OPS = { 修改: "edit", edit: "edit", 暂停: "pause", pause: "pause", 继续: "resume", 恢复: "resume", resume: "resume", 清除: "clear", clear: "clear" };
    const GOAL_OP_LABEL = { pause: "暂停", resume: "继续", clear: "清除" };
    const GOAL_DONE = { create: "设定目标", edit: "修改目标", pause: "暂停目标", resume: "继续目标", clear: "清除目标" };
    function goalCommand(t, rest) {
        if (!rest)
            return buildGoalCard(t);
        const [, word, tail = ""] = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const op = GOAL_OPS[word.toLowerCase()];
        if (op === "edit")
            return tail.trim() ? applyGoal(t, "edit", tail.trim()) : plainText({ head: "⚠️ 用法", body: "`目标 修改 新的目标描述`" });
        if (op && !tail.trim())
            return applyGoal(t, op);
        return applyGoal(t, "create", rest);
    }
    function goalErrorText(text) {
        const s = String(text || "");
        if (/already (active|paused|blocked)/i.test(s))
            return "已有未完成的目标。发送 `目标 修改 新描述` 修改，或 `目标 清除` 后再设定";
        if (/No goal is currently set/i.test(s))
            return "这个会话还没有目标。发送 `目标 描述` 设定";
        return s.split("\n")[0].slice(0, 120) || "未知";
    }
    async function buildGoalCard(t) {
        let r;
        try {
            await t.refreshMeta();
            r = host.goal ? await host.goal(t.sessionId) : null;
        }
        catch (e) {
            return plainText({ head: "⚠️ 读取目标失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试" });
        }
        const g = t.goal;
        if (!g) {
            return plainText({
                head: "🎯 没有目标",
                subject: t.label(),
                body: "设定后模型会在这个会话里自动续跑，直到完成、受阻、暂停或到达轮数上限，结束时推送一次结果。",
                foot: "发送 `目标 描述` 设定",
            });
        }
        // 续跑是否启用只在 /goal 的输出里；Desktop 重启后执行中的目标不会自己接着跑。
        const armed = /^Activation:\s*armed\b/m.test(String(r?.text || ""));
        const ops = g.phase === "active" && armed ? ["pause", "clear"]
            : g.phase === "complete" || goalAtLimit(g) ? ["clear"] : ["resume", "clear"];
        const state = goalLine(g) + (g.phase === "active" && !armed ? "（未续跑）" : "");
        const card = {
            card_type: "vote_interaction",
            title: clip(`🎯 ${g.objective}`, 26),
            desc: clip(`${state} · ${t.label()}`, 30),
            options: ops.map((op) => ({ id: registerPick({ act: "goal", targetKey: t.key, sessionId: t.sessionId, op }), text: GOAL_OP_LABEL[op] })),
            mode: 0,
            submit_text: "确定",
            task_id: taskId("goal"),
        };
        const reason = g.blockedReason?.message ? `\n受阻原因：${g.blockedReason.message}` : "";
        return cardBlock(card, "", () => plainText({
            head: "🎯 当前目标",
            subject: t.label(),
            body: `${g.objective}\n\n状态：${state}${reason}`,
            foot: ops.map((op) => `\`目标 ${GOAL_OP_LABEL[op]}\``).join(" / "),
        }));
    }
    async function applyGoal(t, op, objective = "") {
        const fail = (why) => plainText({ head: `⚠️ ${GOAL_DONE[op]}失败`, subject: t.label(), body: why, foot: "发送 `目标` 查看当前目标" });
        if (!host.goal)
            return fail("当前 DeepSeek Harness 不支持目标。");
        const running = op === "create" || op === "resume";
        // 设定或继续后续跑可能马上开始，先记为手机发起，续跑的结果才推回手机。
        const wasPhone = phoneSessions.has(t.sessionId);
        if (running) {
            await unarchiveFor(t);
            notePhoneSession(t.sessionId, true);
        }
        let r;
        t.goalCmd = true;
        try {
            r = await host.goal(t.sessionId, op === "create" ? objective : op === "edit" ? `edit ${objective}` : op);
        }
        catch (e) {
            r = { kind: "error", text: String(e?.message || e) };
        }
        finally {
            t.goalCmd = false;
        }
        if (r?.kind !== "success") {
            if (running && !wasPhone)
                notePhoneSession(t.sessionId, false);
            return fail(goalErrorText(r?.text));
        }
        await t.refreshMeta();
        if (!goalLive(t.goal))
            t.goalHeld = null;
        const g = t.goal;
        log(`目标 ${op} target=${t.key} → ${g ? goalLine(g) : "无"}`);
        const title = `已${GOAL_DONE[op].replace(/目标$/, "")}目标`;
        const foot = running ? "完成、受阻、暂停或到达上限时推送；发送 `目标` 查看进度" : `会话：${t.label()}`;
        return stateCard({
            tag: "goal",
            icon: "🎯",
            title,
            desc: running ? "自动续跑，结束时推送结果" : "只影响这个会话",
            emph: g && op !== "clear" ? { title: g.objective } : undefined,
            facts: [g && op !== "clear" && { keyname: "状态", value: goalLine(g) }, { keyname: "会话", value: t.label() }],
            fallback: () => plainText({ head: `🎯 ${title}`, subject: g && op !== "clear" ? clipWidth(g.objective, 40) : t.label(), body: g && op !== "clear" ? `状态：${goalLine(g)}` : "", foot }),
        });
    }
    // ---- 插话：运行中发 steer，并入当前这一轮；空闲时就是普通消息 ----
    async function steerInto(t, rest, media, ack) {
        if (!rest && !media.length)
            return plainText({ head: "⚠️ 用法", body: "`插话 内容`：把内容插进正在运行的这一轮；直接发消息则排到下一轮。" });
        if (!t.busy && !t.running)
            return deliverWithMedia(t, rest, media, ack);
        let text;
        try {
            text = await composeWithMedia(rest, media);
        }
        catch (e) {
            if (e instanceof MediaFetchError)
                return fmtNotDelivered(t, e.message);
            throw e;
        }
        pushedKeys = [];
        t.lastActivity = Date.now();
        const { run, queued, error } = await t.deliver(text, "steer");
        markAck(ack, queued);
        if (!queued)
            return fmtNotDelivered(t, error);
        // 这一轮在插话被领取前就结束时，DSH 把它当作下一轮：先挂上回传。
        watchAsync(t, run);
        const cur = pendingRun(t);
        if (cur && cur !== run) {
            cur.muted = false;
            if (!cur.watched)
                watchAsync(t, cur);
        }
        log(`steer target=${t.key} id=${run.id}`);
        return plainText({ head: "💬 已插话", subject: t.label(), body: `> ${clipWidth(text, 40)}\n\n\u3000\n\n并入正在运行的这一轮，完成后推送`, foot: `工作区：${whereLabel(t)}` });
    }
    // ---- 审批 / 提问转手机 ----
    // 提问允许手机直接回文字作答：记录等待文字的请求。
    const WRITE_LABEL = "✏️ 自己写（直接回复文字）";
    const uiPending = new Map();
    // 未绑定的会话发来的弹窗：先不推手机，绑定到该会话时再推（计时从推送时开始）。
    const uiParked = new Map();
    const isBound = (t) => !!currentSessionId && t.sessionId === currentSessionId;
    function flushParkedUi(t) {
        let n = 0;
        for (const [reqId, p] of [...uiParked]) {
            if (p.t !== t)
                continue;
            uiParked.delete(reqId);
            log(`bind → resend ui target=${t.key} kind=${p.req.kind}`);
            openUiPrompt(t, p.req, p.reply);
            n++;
        }
        return n;
    }
    const hasParkedUi = (t) => [...uiParked.values()].some((p) => p.t === t);
    function remindParkedUi(t) {
        notePush(t);
        sendText(plainText({ head: "❓ 等你回答", subject: t.label(), body: "这个会话在等你作答，任务会一直等待。", foot: "引用这条消息回复即可切过去作答" }));
    }
    /** 「关注」：给所有会话里在跑的任务挂上回传，并解除取关。 */
    function remoteAll() {
        muted = false;
        following = true;
        const rows = [];
        for (const t of targets.values()) {
            if (!listedLive(t))
                continue;
            const runs = inflightRuns(t);
            if (!runs.length)
                continue;
            for (const r of runs) {
                r.muted = false;
                if (!r.watched) {
                    watchAsync(t, r);
                    log(`remote → watch inflight target=${t.key} id=${r.id} elapsed=${human(Date.now() - r.startedAt)}`);
                }
            }
            rows.push(t);
        }
        const cur = currentTarget();
        if (!rows.length) {
            return plainText({ head: "📌 关注", body: "目前没有运行中的任务。", foot: "发送 `活跃会话` 选择" });
        }
        const lines = rows.map((t) => {
            const r = pendingRun(t);
            const bits = [t.label(), `已运行 ${human(Date.now() - (r?.startedAt || Date.now()))}`];
            if (hasParkedUi(t))
                bits.push("等你回答");
            if (t === cur)
                bits.push("← 当前");
            return `- ${bits.join(" · ")}`;
        });
        return plainText({
            head: `📌 已关注 · ${rows.length} 个运行中会话`,
            body: `${lines.join("\n")}\n\n这些任务的审批也会发到手机。`,
            foot: "引用消息，回复会发给相应会话",
        });
    }
    /** 「取关」：电脑上发起的轮次（含在跑的）不再推送，手机发起的不受影响。 */
    function muteAll() {
        muted = true;
        following = false;
        const lines = [];
        for (const t of targets.values()) {
            const runs = inflightRuns(t).filter((r) => r.local && r.watched);
            if (!runs.length)
                continue;
            for (const r of runs)
                r.muted = true;
            lines.push(`- ${t.label()} · 已运行 ${human(Date.now() - Math.min(...runs.map((r) => r.startedAt)))}`);
        }
        log(`mute sessions=${lines.length}`);
        const note = "电脑上发起的任务不再推送，手机发起的照常推送。";
        return plainText({
            head: lines.length ? `🔕 已取关 · ${lines.length} 个运行中会话` : "🔕 已取关",
            body: lines.length ? `${lines.join("\n")}\n\n${note}` : note,
            foot: "发送 `关注` 恢复",
        });
    }
    /**
     * 引用了一条「图标 状态 · 会话名」的推送：先在存活会话里按会话名找，没有再到宿主的全部会话里找并打开。
     * 返回 {target} 命中；{missed: 会话名} 认得出是推送引用，但找不到或重名；null 不是推送引用。
     */
    async function quotedTarget(quote) {
        const line = String(quote || "").replace(/^#+\s*/, "").split("\n", 1)[0].trim();
        const m = /^\S+ [^·]+? · (.+)$/.exec(line);
        if (!m)
            return null;
        const name = m[1].trim();
        const same = (label) => clipWidth(label, 32) === name;
        const hits = [...targets.values()].filter((t) => liveTarget(t) && same(t.label()));
        if (hits.length === 1)
            return { target: hits[0] };
        if (hits.length > 1) {
            log(`引用的会话名对应 ${hits.length} 个会话 name=${JSON.stringify(name)}`);
            return { missed: name };
        }
        let sessions = [];
        try {
            sessions = await host.listSessions();
        }
        catch (e) {
            log(`引用查找 session/list 失败：${e?.message || e}`);
        }
        const sids = new Set(sessions.filter((s) => !s.blank && same(oneLine(s.title || ""))).map((s) => s.sessionId));
        for (const t of targets.values())
            if (t.kind === "dsh" && !t.closed && same(t.label()))
                sids.add(t.sessionId);
        if (sids.size !== 1) {
            log(`引用的会话${sids.size ? `名对应 ${sids.size} 个会话` : "已不在"} name=${JSON.stringify(name)}`);
            return { missed: name };
        }
        const sid = [...sids][0];
        const t = targetBySid(sid) || ensureTarget(sessions.find((s) => s.sessionId === sid));
        log(`引用的会话不在活跃中，打开 ${t.key} name=${JSON.stringify(t.label())}`);
        await openTarget(t);
        return { target: t };
    }
    // 超时去向写清楚是「这次审批/提问」被跳过，而不是任务被取消。
    const uiAfterLabel = (kind) => kind === "confirm" ? (UI_POLICY === "ask-then-allow" ? "自动允许" : "自动拒绝") : "跳过提问";
    function uiTimeoutAnswer(kind) {
        return kind === "confirm" ? { confirmed: UI_POLICY === "ask-then-allow" } : { cancelled: true };
    }
    /**
     * 登记一个待回答的弹窗；reply(answer) 把 {confirmed}|{index,value}|{indexes,values}|{custom,value}|{cancelled} 交回 host。
     * 由这里统一计时：到点 confirm 按 remoteConfirm 处理，提问按未回答，任务不会卡住。
     */
    function openUiPrompt(t, req, reply) {
        const kind = String(req.kind);
        const reqId = String(req.reqId || "");
        if (!reqId || uiPending.has(reqId))
            return;
        const title = stripCtrl(String(req.title || "")).trim() || "需要确认";
        const detail = uiFence([String(req.title || ""), String(req.message || "")].filter((x) => x.trim()).join("\n\n"));
        const who = t.label();
        log(`ui ${kind} target=${t.key} ${JSON.stringify(clip(title, 60))}`);
        if (kind === "confirm" && UI_POLICY === "allow") {
            reply({ confirmed: true });
            sendText(plainText({ head: "✅ 已自动允许", subject: who, body: detail, foot: "remoteConfirm 为 allow，不再询问" }));
            return;
        }
        const e = { reqId, t, kind, title, reply, done: false };
        const wait = UI_TIMEOUT_MS;
        const after = uiAfterLabel(kind);
        e.wait = wait;
        e.expire = () => {
            const answer = uiTimeoutAnswer(kind);
            if (settleUiPrompt(e, answer))
                sendText(plainText({ head: `⏱️ 超时未${kind === "confirm" ? "处理" : "答"}，已${uiAfterLabel(kind)}`, subject: who, body: uiFence(title),
                    foot: kind === "confirm" ? "任务继续运行，完成后推送" : "任务仍在运行 · Agent 会按「未回答」继续，完成后推送" }));
        };
        e.timer = setTimeout(e.expire, wait);
        e.timer.unref?.();
        uiPending.set(reqId, e);
        const limit = durLabel(wait);
        let options;
        if (kind === "question") {
            const list = (Array.isArray(req.options) ? req.options : []).filter((x) => typeof x === "string");
            const descs = Array.isArray(req.descriptions) ? req.descriptions : [];
            const room = VOTE_OPT_MAX - (req.allowText ? 2 : 1);
            e.allowText = !!req.allowText;
            e.multi = !!req.multi;
            // 只发卡片：说明并入选项文字。
            options = list.slice(0, room).map((v, i) => [`${i + 1}. ${v}${descs[i] ? ` · ${descs[i]}` : ""}`, { index: i + 1, value: v }]);
            if (e.allowText)
                options.push([WRITE_LABEL, { write: true }]);
            options.push(["取消", { cancelled: true }]);
            if (list.length > room)
                e.more = list.length - room;
            // 说明行首放会话名，多个会话同时提问时能分清；「可直接回复文字」已在选项里，不再占位。
            const hint = [clipWidth(who, 14), e.multi ? "可多选" : "", e.more ? `另 ${e.more} 项请到电脑选` : "", `${limit}内未答将${after}`].filter(Boolean).join(" · ");
            // 卡片标题只放得下约 26 字：题目被截断时先发完整题目，避免只看到半句话就作答。
            // 有短标签（header）时卡片标题改用「步骤 + 标签」，完整题目在前一条消息里。
            const long = Array.from(`❓ ${title}`).length > 26;
            if (long)
                sendText(plainText({ head: "❓ 需要回答", subject: who, body: uiFence(title), foot: e.multi ? "在下方卡片勾选后提交" : "在下方卡片选择" }));
            const short = long && req.header ? `${title.match(/^（\d+\/\d+）/)?.[0] || ""}${stripCtrl(String(req.header))}` : title;
            const card = {
                card_type: "vote_interaction",
                title: clip(`❓ ${short}`, 26),
                desc: clip(hint, 30),
                options: options.map(([text, answer]) => ({ id: registerPick({ act: "ui", reqId, answer, label: text }), text: clip(text, 60) })),
                mode: e.multi ? 1 : 0,
                submit_text: e.multi ? "提交" : "回答",
                task_id: taskId("ui"),
            };
            void transport.send(cardBlock(card, "", () => plainText({ head: "⚠️ 卡片发送失败", body: `${clip(title, 80)}\n\n${limit}内未答将${after}`, foot: `${e.allowText ? "可直接回复文字作答，或" : "请"}到电脑上处理` })));
            return;
        }
        options = [["允许", { confirmed: true }], ["拒绝", { confirmed: false }]];
        sendText(plainText({ head: "🔐 需要确认", subject: who, body: `${detail}\n\n${limit}内未选将${after}`, foot: "在下方卡片选择，或到电脑上处理" }));
        const card = {
            card_type: "vote_interaction",
            title: clip(`🔐 ${title}`, 26),
            desc: clip(`${limit}内未选将${after}`, 30),
            options: options.map(([text, answer]) => ({ id: registerPick({ act: "ui", reqId, answer, label: text }), text: clip(text, 60) })),
            mode: 0,
            submit_text: "确认",
            task_id: taskId("ui"),
        };
        void transport.send(cardBlock(card, "", () => plainText({ head: "⚠️ 卡片发送失败", body: `${clip(title, 80)}\n\n${limit}内未选将${after}`, foot: "请到电脑上处理" })));
    }
    function closeUiPrompt(e) {
        if (e.done)
            return false;
        e.done = true;
        clearTimeout(e.timer);
        uiPending.delete(e.reqId);
        return true;
    }
    function settleUiPrompt(e, answer) {
        if (!closeUiPrompt(e))
            return false;
        try {
            e.reply(answer);
        }
        catch (err) {
            log(`ui reply 失败：${err?.message || err}`);
        }
        return true;
    }
    function dropUiPrompts(t, answer = null) {
        for (const [reqId, p] of [...uiParked]) {
            if (t && p.t !== t)
                continue;
            uiParked.delete(reqId);
            if (answer)
                p.reply(answer);
        }
        for (const e of [...uiPending.values()])
            if (!t || e.t === t)
                answer ? settleUiPrompt(e, answer) : closeUiPrompt(e);
    }
    /** 手机回文字：交给当前会话最早一个允许文字作答的提问；没有则返回 null 照常投递。 */
    function takeTextAnswer(text) {
        const t = currentTarget();
        const open = [...uiPending.values()].filter((x) => x.kind === "question" && x.allowText);
        // 点过「自己写」的优先（最近一次），否则只回答当前会话的提问。
        const e = open.filter((x) => x.awaitText).sort((a, b) => b.awaitText - a.awaitText)[0] || open.find((x) => t && x.t === t);
        if (!e || !text.trim())
            return null;
        settleUiPrompt(e, { custom: true, value: text.trim() });
        log(`ui answered by phone text target=${e.t.key}`);
        return plainText({ head: "✅ 已回答", subject: e.t.label(), body: uiFence(`${e.title}\n→ ${text.trim()}`), foot: "任务继续运行，完成后推送" });
    }
    function handleUiPick(pick, picks = [pick]) {
        const e = uiPending.get(pick.reqId);
        if (!e)
            return "这个请求已经处理过（已超时、已在电脑上回答或会话已结束）。";
        if (e.multi) {
            // 多选卡片：勾了「取消」即取消；勾了「自己写」转文字作答；否则所有勾选项一起交回。
            const mine = picks.filter((x) => x?.reqId === pick.reqId);
            const cancel = mine.find((x) => x.answer.cancelled);
            const write = mine.find((x) => x.answer.write);
            const chosen = mine.filter((x) => x.answer.index);
            if (cancel || (!write && !chosen.length))
                pick = cancel || { ...pick, answer: { cancelled: true }, label: "取消" };
            else if (write)
                pick = write;
            else {
                settleUiPrompt(e, { indexes: chosen.map((x) => x.answer.index), values: chosen.map((x) => x.answer.value) });
                log(`ui answered by phone target=${e.t.key} multi=${chosen.length}`);
                return plainText({ head: "✅ 已选择", subject: e.t.label(), body: uiFence(`${e.title}\n${chosen.map((x) => `→ ${x.label}`).join("\n")}`), foot: "任务继续运行，完成后推送" });
            }
        }
        if (pick.answer.write) {
            e.awaitText = Date.now();
            // 点了「自己写」：重新计时，留出打字时间。
            clearTimeout(e.timer);
            e.timer = setTimeout(e.expire, e.wait);
            e.timer.unref?.();
            return plainText({ head: "✏️ 请直接回复文字", subject: e.t.label(), body: uiFence(e.title), foot: "下一条非命令消息将作为答案" });
        }
        settleUiPrompt(e, pick.answer);
        log(`ui answered by phone target=${e.t.key} ${JSON.stringify(pick.label)}`);
        const refused = pick.answer.confirmed === false || pick.answer.cancelled;
        return plainText({ head: `${refused ? "🚫" : "✅"} 已${pick.answer.value !== undefined ? "选择" : pick.label}`, subject: e.t.label(), body: uiFence(pick.answer.value !== undefined ? `${e.title}\n→ ${pick.label}` : e.title), foot: "任务继续运行，完成后推送" });
    }
    const NO_BIND = () => plainText({ head: "⚠️ 未选会话", body: "还没有选定要操作的会话。", foot: "发送 `活跃会话` 选择，或 `创建会话` 新建" });
    /** 状态栏信息：目录(分支)、模型·思考强度、上下文、token 用量。 */
    async function footerInfo(t) {
        await t.footer();
        const u = t.tokenUsage;
        const lines = [
            `工作区：${whereLabel(t)}`,
            `模型：${t.model || "未知"}${t.thinkingLevel ? ` · ${t.thinkingLevel}` : ""}`,
            `上下文：${contextLabel(t, null)}`,
        ];
        if (t.permission)
            lines.push(`权限模式：${t.permission}`);
        if (t.goal)
            lines.push(`目标：${goalLine(t.goal)}`);
        if (u) {
            const input = (Number(u.uncachedInputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
            lines.push(`用量：输入 ${kilo(input)} · 输出 ${kilo(Number(u.outputTokens) || 0)}${Number(u.cacheReadTokens) > 0 ? ` · 缓存命中 ${kilo(u.cacheReadTokens)}` : ""}`);
        }
        return lines;
    }
    const mutedFoot = () => (muted ? ["已取关：电脑任务不推送"] : []);
    /** 除当前会话外还有运行中的会话时，先用卡片选看哪个；否则直接回当前会话的状态。 */
    function statusPick() {
        const cur = currentTarget();
        const running = [...targets.values()].filter((t) => t !== cur && t.busy && liveTarget(t)).sort((a, b) => b.lastActivity - a.lastActivity);
        const rows = [...(cur ? [cur] : []), ...running];
        if (rows.length < 2)
            return statusCard(rows[0]);
        const card = {
            card_type: "vote_interaction",
            title: "📊 查看状态",
            desc: `运行中 ${rows.filter((t) => t.busy).length} 个 · 选择要查看的会话`,
            options: rows.slice(0, VOTE_OPT_MAX).map((t) => ({ id: registerPick({ act: "status", targetKey: t.key, sessionId: t.sessionId }), text: optText(t) })),
            mode: 0,
            submit_text: "查看状态",
            task_id: taskId("status"),
        };
        return cardBlock(card, PICK_LEAD, () => plainText({
            head: "⚠️ 卡片发送失败",
            subject: "查看状态",
            body: rows.map((t) => `- ${optText(t)}`).join("\n"),
            foot: "发送 `活跃会话` 切换后，再发 `状态` 查看",
        }));
    }
    async function statusCard(t = currentTarget()) {
        if (!t)
            return NO_BIND();
        const info = (await footerInfo(t)).map((l) => `- ${l}`).join("\n");
        const tunnel = transport.connected ? [] : ["企微：断开"];
        const stopHint = t === currentTarget() ? "发送 `停止` 停止" : "引用消息，回复会发给该会话";
        if (t.busy) {
            const r = pendingRun(t);
            const stopping = r.stopRequestedAt ? `\n\n${human(Date.now() - r.stopRequestedAt)}前已请求中断，等待这一轮结束。` : "";
            return plainText({
                head: "⏳ 运行中",
                subject: t.label(),
                body: `已运行 ${human(Date.now() - r.startedAt)}${r.tool ? `，当前动作：${toolLabel(r.tool)}` : ""}。${stopping}\n\n${info}`,
                foot: [...tunnel, ...mutedFoot(), stopHint].join(" · "),
            });
        }
        return plainText({
            head: "🧊 空闲",
            subject: t.label(),
            body: `等你发消息，上次活动 ${ago(t.lastActivity)}。\n\n${info}`,
            foot: [...tunnel, ...mutedFoot()].join(" · "),
        });
    }
    // ---- 默认位置：之后新建的会话进哪个工作区（`创建会话` 不带位置时），已有会话不动；默认未分组 ----
    function defaultPlace() {
        let saved = {};
        try {
            saved = JSON.parse(fs.readFileSync(DEFAULT_PLACE_FILE, "utf8")) || {};
        }
        catch { }
        if (saved.workspaceId) {
            const ws = wsState.items.find((w) => w.id === saved.workspaceId);
            if (ws)
                return { ws, cwd: ws.path };
        }
        if (typeof saved.cwd === "string" && saved.cwd) {
            try {
                if (fs.statSync(saved.cwd).isDirectory())
                    return { ws: null, cwd: saved.cwd };
            }
            catch { }
        }
        return { ws: null, cwd: "" };
    }
    const samePlace = (a, b) => (a.ws || b.ws ? a.ws?.id === b.ws?.id : a.cwd === b.cwd);
    function applyDefaultPlace(p) {
        if (!p.ws && !p.cwd)
            fs.rmSync(DEFAULT_PLACE_FILE, { force: true });
        else
            fs.writeFileSync(DEFAULT_PLACE_FILE, JSON.stringify(p.ws ? { workspaceId: p.ws.id } : { cwd: p.cwd }) + "\n", { mode: 0o600 });
        log(`默认位置 → ${placeName(p)}`);
        const note = p.ws ? "之后新建的会话归入这个工作区" : p.cwd ? "这个目录不是工作区，新会话进「未分组」" : "新会话进「未分组」，与 Desktop 不选工作区时一样";
        return stateCard({
            tag: "cwd",
            icon: "📁",
            title: "切换工作区",
            desc: note,
            emph: { title: p.ws ? p.ws.title : "未分组", ...(p.cwd ? { desc: tilde(p.cwd) } : {}) },
            emphMax: EMPH_NAME_MAX,
            fallback: () => plainText({ head: "📁 已切换工作区", subject: placeName(p), body: note, foot: "发送 `创建会话 工作区名 消息`，指定工作区" }),
        });
    }
    async function buildDirCard(arg) {
        await refreshWorkspaces();
        if (arg) {
            const p = resolvePlace(arg);
            if (!p)
                return plainText({ head: "⚠️ 切换工作区失败", body: `没有叫「${clip(arg, 30)}」的工作区、别名或目录`, foot: "发送 `工作区` 从列表中选择" });
            return applyDefaultPlace(p);
        }
        const cur = defaultPlace();
        const rows = [...wsState.items.map((ws) => ({ ws, cwd: ws.path })), { ws: null, cwd: "" }];
        // 不是工作区的别名目录也列出，新会话进未分组但在该目录。
        for (const [name, d] of Object.entries(dirAliases())) {
            const p = resolvePlace(name);
            if (p && !p.ws && p.cwd && !rows.some((r) => !r.ws && r.cwd === p.cwd))
                rows.push({ ...p, alias: name });
        }
        if (cur.cwd && !cur.ws && !rows.some((r) => samePlace(r, cur)))
            rows.push(cur);
        const shown = rows.slice(0, VOTE_OPT_MAX);
        const optLabel = (p) => [p.ws ? p.ws.title : p.alias ? `${p.alias} · 未分组` : "未分组", p.cwd ? tilde(p.cwd) : "", samePlace(p, cur) ? "← 当前" : ""].filter(Boolean).join(" · ");
        const options = shown.map((p) => ({
            id: registerPick({ act: "cwd", workspaceId: p.ws?.id || "", dir: p.ws ? "" : p.cwd }),
            text: optLabel(p),
        }));
        const card = {
            card_type: "vote_interaction",
            title: clip("📁 切换工作区", 26),
            desc: wsState.items.length ? "新建会话默认归入所选工作区" : "Desktop 里还没有工作区，可先在电脑上添加",
            options,
            mode: 0,
            submit_text: "切换工作区",
            task_id: taskId("cwd"),
        };
        return cardBlock(card, "**请选择工作区**", () => plainText({
            head: "⚠️ 卡片发送失败",
            subject: "切换工作区",
            body: shown.map(optLabel).join("\n"),
            foot: "发送 `工作区 名称` 直接切换",
        }));
    }
    async function handleDirPick(pick) {
        await refreshWorkspaces();
        if (pick.workspaceId) {
            const ws = wsState.items.find((w) => w.id === pick.workspaceId);
            if (!ws)
                return plainText({ head: "⚠️ 切换工作区失败", body: "这个工作区已在 Desktop 里移除", foot: "发送 `工作区` 重新选择" });
            return applyDefaultPlace({ ws, cwd: ws.path });
        }
        if (pick.dir) {
            let ok = false;
            try { ok = fs.statSync(pick.dir).isDirectory(); } catch { }
            if (!ok)
                return plainText({ head: "⚠️ 切换工作区失败", body: `目录已不存在：${tilde(pick.dir)}`, foot: "发送 `工作区` 重新选择" });
            return applyDefaultPlace(workspaceAt(pick.dir) ? { ws: workspaceAt(pick.dir), cwd: pick.dir } : { ws: null, cwd: pick.dir });
        }
        return applyDefaultPlace({ ws: null, cwd: "" });
    }
    // ---- 会话产物：识别规则见 artifacts.mjs，状态挂在 target 上 ----
    function scanArtifacts(t) {
        return t.art ? listArtifacts(t.art, { trackedCache: t.artTracked }) : [];
    }
    function artHint(t) {
        const n = scanArtifacts(t).length;
        if (!n || n === t.artHinted)
            return "";
        t.artHinted = n;
        // 与正文之间留一行可见空行（企微会合并普通空行，沿用受理卡的全角空格行）。
        return `\n\n\u3000\n\n📎 本会话已有 ${n} 个产物，回复 \`产物\` 查看`;
    }
    async function buildArtCard(t) {
        await t.loadHistory?.();
        const all = scanArtifacts(t);
        if (!all.length)
            return plainText({ head: "📎 暂无产物", subject: t.label(), body: "本会话还没有生成 HTML / 文档类文件。", foot: "支持：html md pdf docx xlsx pptx png svg" });
        if (all.length <= ART_DIRECT_MAX)
            return sendArtifacts(all);
        const rows = all.slice(0, ART_LIST_MAX);
        const options = rows.map((r) => ({
            id: registerPick({ act: "art", file: r.file }),
            text: clip(`${path.basename(r.file)} · ${fmtSize(r.size)} · ${ago(r.mtime)}`, 60),
        }));
        const card = {
            card_type: "vote_interaction",
            title: clip("📎 会话产物", 26),
            desc: clip(all.length > rows.length ? `共 ${all.length} 个 · 仅显示最近 ${rows.length} 个` : `共 ${all.length} 个 · 可多选`, 30),
            options,
            mode: 1,
            submit_text: "发送文件",
            task_id: taskId("art"),
        };
        return cardBlock(card, "**请选择要发送的文件**", () => plainText({
            head: "📎 会话产物",
            subject: t.label(),
            body: rows.map((r) => `- ${tilde(r.file)} · ${fmtSize(r.size)}`).join("\n"),
            foot: "卡片发送失败，请到电脑上取用",
        }));
    }
    function sendArtifacts(picks) {
        const notes = [];
        for (const pick of picks) {
            const name = path.basename(pick.file);
            let st = null;
            try {
                st = fs.statSync(pick.file);
            }
            catch { }
            if (!st?.isFile() || !artAllowed(pick.file))
                notes.push(`${name}：文件已不存在`);
            else if (st.size > ART_SEND_MAX)
                notes.push(`${name}：超过 50MB，未发送`);
            else
                void transport.send({ file: pick.file });
        }
        return notes.length ? plainText({ head: "⚠️ 部分文件未发送", body: notes.join("\n") }) : "";
    }
    // ---- 新建 / 选择会话 ----
    /** 首个词是工作区名 / 未分组 / 别名 / 路径时作为位置，否则用默认位置。 */
    async function splitPlaceAndMsg(rest) {
        await refreshWorkspaces();
        const maybe = rest.split(/\s+/).filter(Boolean)[0];
        const p = maybe ? resolvePlace(maybe) : null;
        if (p)
            return { place: p, msg: rest.slice(rest.indexOf(maybe) + maybe.length).trim() };
        return { place: defaultPlace(), msg: rest };
    }
    async function finishCreate(t, msg, media, ack, note = "") {
        bindCurrent(t);
        await buildList();
        let r = null;
        if (msg || media?.length) {
            try {
                r = await deliverAsync(t, await composeWithMedia(msg || "", media), ack);
            }
            catch (e) {
                if (!(e instanceof MediaFetchError))
                    throw e;
                r = { notDelivered: true, error: e.message };
            }
            // DSH 先给首条消息截断的临时标题，模型起的标题稍后才到。
            if (!r?.notDelivered && !t.titleFinal) {
                const t0 = Date.now();
                while (!t.titleFinal && !stopped && Date.now() - t0 < NAME_WAIT_MS)
                    await delay(100);
                log(`创建会话 等会话名 ${t.titleFinal ? `命中 ${Date.now() - t0}ms` : `超时 ${NAME_WAIT_MS}ms，用临时标题`}`);
            }
        }
        const foot = [`工作区：${whereLabel(t)}`];
        if (r?.notDelivered) {
            return plainText({
                head: "⚠️ 首条未送达",
                subject: t.label(),
                body: "会话已经建好，但刚才那条消息没送进去，附件已保留。请重发。" + (r.error ? `\n\n原因：${String(r.error).slice(0, 60)}` : ""),
                foot: [...foot, note].filter(Boolean).join(" · "),
            });
        }
        return buildCreatedCard(t, note);
    }
    function openDesktop() {
        return new Promise((res) => execFile("open", ["dsh://open"], { timeout: 5000 }, (e) => res(!e)));
    }
    async function newSession(place, msg, media, ack, { front }) {
        let sid;
        try {
            sid = await host.createSession(place.ws ? { workspaceId: place.ws.id } : place.cwd ? { cwd: place.cwd } : {});
        }
        catch (e) {
            return plainText({ head: "⚠️ 新建失败", subject: placeName(place), body: String(e?.message || e).slice(0, 120), foot: "确认电脑上的 DeepSeek Harness 正在运行" });
        }
        const t = ensureTarget({ sessionId: sid, cwd: place.cwd });
        t.opened = true;
        t.active = true;
        await Promise.all([t.refreshMeta(), refreshWorkspaces()]);
        log(`创建会话 ${t.key} 位置=${placeName(place)}${front ? "" : "（后台）"}`);
        let note = "";
        if (front && CFG.openDesktop) {
            if (await screenLocked())
                note = "屏幕已锁，未拉起 Desktop";
            else if (!(await openDesktop()))
                note = "未能拉起 Desktop";
        }
        return finishCreate(t, msg, media, ack, note);
    }
    async function applyPick(pick, rows) {
        let row = rows.find((x) => x.key === pick.targetKey);
        if (!row && pick.sessionId)
            row = rows.find((x) => x.sessionId === pick.sessionId);
        const fail = () => plainText({
            head: "⚠️ 切换失败",
            subject: pick.name || "会话",
            body: "会话已关闭或不在列表里",
            foot: "发送 `活跃会话` 重新选择",
        });
        if (!row)
            return fail();
        const t = await resolveNumber(rows.indexOf(row) + 1);
        if (!t)
            return fail();
        bindCurrent(t);
        return buildSelectedCard(t);
    }
    // ---- 回顾：最近一轮已结束的对话，规则见 recap.mjs ----
    async function buildRecap(t) {
        let turn;
        try {
            turn = lastTurn(await host.snapshot(t.sessionId));
        }
        catch (e) {
            log(`回顾读取失败 ${t.key}: ${e?.message || e}`);
            return plainText({ head: "⚠️ 读取失败", subject: t.label(), body: "会话记录暂时读不到，请稍后重试。" });
        }
        if (!turn)
            return plainText({ head: "📜 暂无可回顾", subject: t.label(), body: t.busy ? "第一轮还在进行中，完成后推送。" : "这个会话还没有已结束的对话。" });
        const head = turn.status === "aborted" ? "📜 回顾（已中断）" : turn.status === "error" ? "📜 回顾（出错）" : "📜 回顾";
        const subject = t.label();
        const prompt = oneLine(turn.prompt) || "（无文字）";
        const text = turn.text || "（无文本输出）";
        const foot = [`工作区：${whereLabel(t)}`, ago(turn.endedAt || Date.now())];
        if (turn.startedAt && turn.endedAt)
            foot.push(`运行：${human(turn.endedAt - turn.startedAt)}`);
        if (t.busy)
            foot.push("当前任务进行中");
        const quote = `> ${clipWidth(prompt, 60)}\n\n\u3000\n\n`;
        const full = plainText({ head, subject, body: quote + text, foot: foot.join(" · ") });
        if (Buffer.byteLength(full) <= PUSH_TEXT_MAX_BYTES)
            return full;
        try {
            const file = await uploadMdDoc({ name: subject, cwd: t.cwd, meta: `回顾 · ${text.length} 字`, body: `> ${prompt}\n\n${text}` });
            return { text: plainText({ head, subject, body: quote + "字数超限，请查看 Markdown。", foot: foot.join(" · ") }), file };
        }
        catch {
            return plainText({ head, subject, body: `${quote}${truncateUtf8(text, PUSH_TEXT_MAX_BYTES - 600)}\n\n…（共 ${text.length} 字，已截断）`, foot: foot.join(" · ") });
        }
    }
    async function buildSelectedCard(t) {
        await t.refreshMeta();
        const name = t.name || t.hint || "新会话";
        const facts = [
            ...placeFacts(t),
            { keyname: "模型", value: t.model || "未知" },
            { keyname: "上下文", value: contextLabel(t, null) },
        ];
        return stateCard({
            tag: "selected",
            icon: "📥",
            title: "选择会话",
            desc: t.busy ? "进行中，完成后推送结果" : "已选择，可开始对话",
            emph: { title: name },
            emphMax: EMPH_NAME_MAX,
            body: t.busy ? "" : RECAP_TIP,
            facts,
            fallback: () => plainText({ head: "📥 选择会话", subject: name, body: t.busy ? "" : RECAP_TIP, foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
        });
    }
    function buildCreatedCard(t, note = "") {
        const name = t.name || t.hint || "新会话";
        const text = () => plainText({
            head: "✏️ 会话已创建",
            subject: name,
            foot: [`工作区：${whereLabel(t)}`, `模型：${t.model || "未知"}`, note, t.busy ? "" : "发送 `创建会话 工作区名 消息`，指定工作区"].filter(Boolean).join(" · "),
        });
        return stateCard({
            tag: "created",
            lead: `**✏️ 已创建 ${clip(name, 20)}**`,
            icon: "✏️",
            title: "创建会话",
            desc: t.busy ? "任务已开始，完成后推送结果" : "发「创建会话 工作区名 消息」，指定工作区",
            body: note,
            emph: { title: name },
            emphMax: EMPH_NAME_MAX,
            facts: [
                ...placeFacts(t),
                { keyname: "模型", value: t.model || "未知" },
            ],
            fallback: text,
        });
    }
    const PICK_AGAIN = { model: ["模型", "切换模型"], cwd: ["工作区", "切换工作区"], think: ["思考强度", "切换思考强度"], perm: ["权限模式", "切换权限模式"], goal: ["目标", "目标"], status: ["状态", "状态"] };
    async function handleCardCallback({ taskId, optionId, optionIds = [] }) {
        lastPhoneAt = Date.now();
        const pick = cardPicks.get(optionId);
        if (pick?.act === "art") {
            if (pick.taskId !== taskId || Date.now() - pick.at > CARD_TTL_MS)
                return "这张产物卡片已失效，请发送 `产物` 重新获取。";
            if (consumeTask(taskId))
                return "这张卡片已经提交过，请发送 `产物` 获取新卡片。";
            return sendArtifacts((optionIds.length ? optionIds : [optionId]).map((id) => cardPicks.get(id)).filter((x) => x?.act === "art" && x.taskId === taskId));
        }
        if (pick?.act === "ui" && pick.taskId === taskId) {
            if (consumeTask(taskId))
                return "这张卡片已经提交过。";
            return handleUiPick(pick, (optionIds.length ? optionIds : [optionId]).map((id) => cardPicks.get(id)).filter((x) => x?.act === "ui" && x.taskId === taskId));
        }
        if (pick?.act === "route") {
            if (pick.taskId !== taskId)
                return "这张卡片已失效，消息未投递，请重发。";
            if (consumeTask(taskId))
                return "这张卡片已经提交过。";
            return handleRoutePick(pick);
        }
        const again = PICK_AGAIN[pick?.act];
        if (!pick || pick.taskId !== taskId || Date.now() - pick.at > CARD_TTL_MS) {
            return again ? `这张${again[0]}卡片已失效，请发送 \`${again[1]}\` 重新选择。` : "这张会话卡片已失效，请发送 `活跃会话` 或 `历史会话` 重新选择。";
        }
        if (consumeTask(taskId))
            return again ? `这张卡片已经提交过，请发送 \`${again[1]}\` 获取新卡片。` : "这张卡片已经提交过，请发送 `活跃会话` 或 `历史会话` 获取新卡片。";
        if (pick.act === "model")
            return handleModelPick(pick);
        if (pick.act === "think")
            return handleThinkPick(pick);
        if (pick.act === "cwd")
            return handleDirPick(pick);
        if (pick.act === "perm") {
            const t = pickTarget(pick);
            return t ? applyPermission(t, pick.preset) : plainText({ head: "⚠️ 切换权限模式失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
        }
        if (pick.act === "status") {
            const t = pickTarget(pick);
            return liveTarget(t) ? statusCard(t) : plainText({ head: "⚠️ 查看状态失败", body: "所选会话已关闭。", foot: "发送 `状态` 重新选择" });
        }
        if (pick.act === "goal") {
            const t = pickTarget(pick);
            return t ? applyGoal(t, pick.op) : plainText({ head: "⚠️ 目标操作失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
        }
        const rows = await buildList({ find: pick.find || "", includeSub: !!pick.includeSub });
        return applyPick(pick, rows);
    }
    /** 暂存这条消息，用卡片问清发给当前会话还是刚推送的会话；missed 为引用了却找不到的会话名。 */
    function routeCard(cur, others, raw, media, ack, missed = "") {
        const held = { raw, media };
        const opt = (t, tag) => ({ id: registerPick({ act: "route", targetKey: t.key, sessionId: t.sessionId, held }), text: clip(tag ? `${t.label()} ← ${tag}` : t.label(), 60) });
        const content = [raw ? clipWidth(raw, 40) : "", media.length ? `（${media.length} 个附件）` : ""].join("");
        const card = {
            card_type: "vote_interaction",
            title: missed ? "✉️ 引用的会话不在，发给哪个？" : "✉️ 发给哪个会话？",
            desc: missed ? `找不到「${clipWidth(missed, 20)}」 · 消息内容：${content}` : `消息内容：${content}`,
            options: [opt(cur, "当前"), ...others.slice(0, VOTE_OPT_MAX - 1).map((t, i) => opt(t, i || missed ? "" : "刚推送"))],
            mode: 0,
            submit_text: "发送",
            task_id: taskId("route"),
        };
        if (media.length)
            ack.media = true;
        log(missed ? `引用的会话找不到，当前是 ${cur.key}：暂存消息，待选择` : `推送过的是 ${others.map((t) => t.key).join(",")}，当前是 ${cur.key}：暂存消息，待选择`);
        return cardBlock(card, "**消息未投递，请选择会话**", () => plainText({
            head: "✉️ 消息未投递",
            body: missed ? `找不到引用的会话「${clipWidth(missed, 20)}」，当前会话是「${clipWidth(cur.label(), 20)}」。`
                : `刚收到「${others.map((t) => clipWidth(t.label(), 20)).join("」「")}」的推送，当前会话是「${clipWidth(cur.label(), 20)}」。`,
            foot: missed ? "发送 `活跃会话` 切换后重发" : "引用推送重发，或发送 `活跃会话` 切换后重发",
        }));
    }
    async function handleRoutePick(pick) {
        const t = [targets.get(pick.targetKey), targetBySid(pick.sessionId)].find(liveTarget);
        if (!t)
            return plainText({ head: "⚠️ 消息未投递", body: "所选会话已关闭，请重发。", foot: "发送 `活跃会话` 重新选择" });
        if (t !== currentTarget()) {
            log(`选择投递 → 切换到 ${t.key}`);
            if (bindCurrent(t))
                return plainText({ head: "📥 已切换", subject: t.label(), body: "待答的问题已推送，请在卡片上作答。这条消息没有投递，需要的话请重发。" });
        }
        return deliverWithMedia(t, pick.held.raw, pick.held.media, null);
    }
    async function stopCurrent() {
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        if (!t.busy && !t.running)
            return plainText({ head: "🧊 无需中断", subject: t.label(), body: "当前空闲，没有在跑的任务" });
        const run = pendingRun(t);
        if (run) {
            run.stopped = run.stopByCmd = true;
            run.stopRequestedAt ||= Date.now();
        }
        const ok = await t.abort();
        if (!ok) {
            if (run) {
                run.stopped = run.stopByCmd = false;
                run.stopRequestedAt = 0;
            }
            return plainText({ head: "⚠️ 中断失败", subject: t.label(), foot: "发送 `状态` 查看" });
        }
        return plainText({
            head: "⚠️ 已中断",
            subject: t.label(),
            body: "任务已停止",
            foot: `已运行 ${run ? runFor(run) : "-"}`,
        });
    }
    async function handleCommand(text, media = [], ack = { media: false }, { quote = "" } = {}) {
        lastPhoneAt = Date.now();
        if (stopped)
            return "遥控服务正在重启，这条消息未处理，请稍后重发。";
        const quoted = await quotedTarget(quote);
        const via = quoted?.target || null;
        if (via && via !== currentTarget()) {
            log(`引用回复 → ${via.key} name=${JSON.stringify(via.label())}`);
            if (bindCurrent(via)) {
                return plainText({ head: "📥 已切换", subject: via.label(), body: "待答的问题已推送，请在卡片上作答。这条消息没有投递，需要的话请重发。" });
            }
        }
        const raw = text.trim();
        const parsed = parseCmd(raw);
        if (!parsed && !media.length) {
            const answered = takeTextAnswer(raw);
            if (answered)
                return answered;
        }
        if (!parsed) {
            const t = currentTarget();
            if (!t) {
                const rows = await buildList();
                const live = liveRows(rows);
                if (!live.length) {
                    return plainText({
                        head: "⚠️ 消息未投递",
                        body: "还没有会话可以接收这条消息。先新建或找回一个，再重发。",
                        foot: "发送 `创建会话` 新建，或 `历史会话` 找回会话",
                    });
                }
                if (media.length)
                    log(`未绑定会话，${media.length} 个附件随正文一同未投递（已回报 mediaAccepted=false）`);
                const options = live.slice(0, VOTE_OPT_MAX).map((x) => selOpt(x));
                const card = {
                    card_type: "vote_interaction",
                    title: clip("⚠️ 发给哪个会话？", 26),
                    desc: "消息未投递 · 请先选择会话，再重发",
                    options,
                    mode: 0,
                    submit_text: "绑定会话",
                    task_id: taskId("bind"),
                };
                log(`未绑定会话，退回选择卡（活跃 ${live.length} 个），原文未投递`);
                return cardBlock(card, "**消息未投递，请先选择会话**", () => renderList(live, rows, "消息未投递"));
            }
            if (quoted?.missed)
                return routeCard(t, activeList().filter((x) => x !== t && liveTarget(x)), raw, media, ack, quoted.missed);
            const others = via ? [] : pushedOthers(t);
            if (others.length)
                return routeCard(t, others, raw, media, ack);
            return deliverWithMedia(t, raw, media, ack);
        }
        const { cmd, rest } = parsed;
        if (parsed.alias || parsed.bare)
            log(`${parsed.alias ? `中文说法 ${parsed.alias}` : `免前缀 ${cmd}`} → ${cmd}${rest ? ` ${JSON.stringify(rest.slice(0, 60))}` : ""}`);
        if (media.length && ["ls", "h", "status", "help", "stop", "model", "cd", "think", "compact", "art", "remote", "mute", "restart", "perm", "goal", "recap"].includes(cmd))
            log(`命令 ${cmd} 不投递内容，${media.length} 个附件未受理（mediaAccepted=false）`);
        if (cmd === "help")
            return helpText();
        if (cmd === "remote")
            return remoteAll();
        if (cmd === "mute")
            return muteAll();
        if (cmd === "ls")
            return buildLsCard(await buildList());
        if (cmd === "h") {
            const m = /^(?:all|全部)(?:\s+|$)(.*)$/i.exec(rest || "");
            return buildHistCard(await buildList({ find: m ? m[1] : rest, includeSub: !!m }));
        }
        if (/^\d+$/.test(cmd)) {
            const n = parseInt(cmd, 10);
            const t = await resolveNumber(n);
            if (!t) {
                return plainText({
                    head: "⚠️ 找不到会话",
                    body: `没有第 ${n} 个。序号会随列表刷新变化，以最新列表为准。`,
                    foot: "发送 `活跃会话` 或 `历史会话` 重新查看",
                });
            }
            bindCurrent(t);
            if (!rest) {
                if (media.length)
                    log(`选择会话 ${n} 仅切换会话、不投递内容，${media.length} 个附件未受理`);
                return buildSelectedCard(t);
            }
            return deliverWithMedia(t, rest, media, ack);
        }
        if (cmd === "n" || cmd === "nb") {
            const { place, msg } = await splitPlaceAndMsg(rest);
            return newSession(place, msg, media, ack, { front: cmd === "n" });
        }
        if (cmd === "stop")
            return stopCurrent();
        if (cmd === "status")
            return statusPick();
        if (cmd === "restart")
            return restartRemote(rest);
        if (cmd === "cd")
            return buildDirCard(rest);
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        if (cmd === "steer")
            return steerInto(t, rest, media, ack);
        if (cmd === "perm")
            return buildPermCard(t, rest);
        if (cmd === "goal")
            return goalCommand(t, rest);
        if (cmd === "model")
            return buildModelCard(t, rest);
        if (cmd === "think")
            return buildThinkCard(t, rest);
        if (cmd === "compact")
            return compactCard(t, rest);
        if (cmd === "art")
            return buildArtCard(t);
        if (cmd === "recap")
            return buildRecap(t);
        return plainText({ head: "⚠️ 未实现的命令", body: cmd, foot: "发送 `帮助` 查看命令" });
    }
    /** 重启插件内的遥控服务：回执排进发件箱后由宿主停掉本实例、按最新配置重建。 */
    function restartRemote(rest) {
        const force = /^(force|强制)$/i.test(rest);
        if (rest && !force)
            return plainText({ head: "⚠️ 用法", body: "`重启` 或 `重启 force`（force 不等任务结束，结果不再回传）" });
        if (!onRestart)
            return plainText({ head: "⚠️ 无法重启", body: "当前运行方式不支持远程重启。", foot: "请在电脑上重启 DeepSeek Harness" });
        const busy = [...targets.values()].filter((t) => listedLive(t) && t.busy);
        if (busy.length && !force) {
            return plainText({
                head: "⚠️ 仍有任务运行",
                body: busy.map((t) => t.label()).join("\n"),
                foot: "等任务结束，或发送 `重启 force` 强制重启（任务继续跑，结果不再回传）",
            });
        }
        log(`收到重启命令 force=${force} busy=${busy.length}`);
        later(() => onRestart(), 1500);
        return plainText({ head: "🔄 正在重启", body: "几秒后自动重连，连上后会收到一条确认。", foot: "Desktop 里的会话不受影响" });
    }
    // ---- host 回调：DSH 会话事件 → Run / Target ----
    function sessionSeen(info) {
        if (stopped || !info?.sessionId)
            return;
        ensureTarget(info);
    }
    function sessionGone(sid) {
        const t = targetBySid(sid);
        if (!t)
            return;
        t.active = false;
        t.running = false;
        for (const r of inflightRuns(t))
            settleLost(t, r, "会话已关闭");
        log(`unregister dsh ${t.key}`);
    }
    function sessionStatus(sid, running) {
        if (stopped)
            return;
        const t = targetBySid(sid) || (running ? ensureTarget({ sessionId: sid }) : null);
        if (!t)
            return;
        t.running = !!running;
        if (running) {
            t.active = true;
            t.lastActivity = Date.now();
        }
        else
            later(() => reapIdle(t), IDLE_REAP_MS);
    }
    /** 会话已空闲却仍未结束的轮次：没开始的手机消息、漏收 turn/end 的轮次。 */
    function reapIdle(t) {
        if (stopped || t.running || t.closed)
            return;
        for (const r of inflightRuns(t)) {
            if (Date.now() - r.startedAt < IDLE_REAP_MS)
                continue;
            settleLost(t, r, r.begun ? "没有收到这一轮的结束事件" : "消息没有进入会话");
        }
        if (t.turnRun?.settled)
            t.turnRun = null;
    }
    /**
     * 一轮的第一条用户消息：rpcId 带手机前缀的接上投递时登记的 loop，否则是电脑发起的轮次。
     * trigger（schedule / goal）是宿主自己唤起的轮次：会话最近一次用户消息来自手机时按手机发起推送。
     */
    function turnBegin(sid, { rpcId = "", text = "", trigger = "" } = {}) {
        if (stopped)
            return;
        const t = ensureTarget({ sessionId: sid });
        t.active = true;
        t.running = true;
        t.lastActivity = Date.now();
        const prev = t.turnRun;
        if (prev && !prev.settled && prev.id !== rpcId)
            settleLost(t, prev, "没有收到上一轮的结束事件");
        let run = rpcId ? t.loops.get(rpcId) : null;
        const phone = rpcId.startsWith(PHONE_RPC_PREFIX);
        if (!trigger && (rpcId || text))
            notePhoneSession(sid, phone);
        if (!run || run.settled) {
            const viaPhone = phone || (!!trigger && phoneSessions.has(sid));
            run = new Run();
            if (rpcId)
                run.id = rpcId;
            run.local = !viaPhone;
            run.trigger = trigger;
            t.loops.set(run.id, run);
            t.trimLoops();
            if (!t.name && !trigger)
                t.hint = promptHint(text);
            const bound = isBound(t);
            if (viaPhone || bound) {
                run.muted = muted && run.local;
                watchAsync(t, run);
            }
            log(`loop open target=${t.key} id=${run.id} ${trigger ? `${trigger} ` : ""}${viaPhone ? "phone" : "local"}${bound ? "" : " unbound"} ${JSON.stringify(String(text).slice(0, 60))}`);
        }
        run.begun = true;
        t.turnRun = run;
        t.run = run;
        // 投影里的轮数只在 goal/change 时更新，续跑提示词里的 Round: N/M 才是当前轮。
        const round = trigger === "goal" && /^Round:\s*(\d+)\/\d+/m.exec(String(text));
        if (round && t.goal)
            t.goal.roundsStarted = Math.max(t.goal.roundsStarted, Number(round[1]));
    }
    function output(sid, text) {
        const run = targetBySid(sid)?.turnRun;
        if (!run || run.settled || !text)
            return;
        run.assistantTexts.push(String(text));
        run.lastOutputAt = Date.now();
    }
    function activity(sid, tool) {
        const t = targetBySid(sid);
        const run = t?.turnRun;
        if (!run || run.settled)
            return;
        t.lastActivity = run.lastOutputAt = Date.now();
        run.tool = String(tool || "").slice(0, 80);
        run.toolCalls++;
    }
    /** kind：completed | aborted | error | max-tokens。 */
    function turnEnd(sid, { kind = "completed", error = "" } = {}) {
        const t = targetBySid(sid);
        if (!t)
            return;
        t.lastActivity = Date.now();
        const run = t.turnRun;
        t.turnRun = null;
        if (!run || run.settled)
            return;
        if (kind === "aborted")
            run.stopped = true;
        else if (kind === "error")
            run.error = String(error || "未知错误");
        else if (kind === "max-tokens" && !run.lastText)
            run.error = "输出达到长度上限";
        if (run.trigger === "goal")
            run.goalAtEnd = t.goal && { ...t.goal };
        run.settle();
        t.noteSettled(run);
        if (t.run === run)
            t.run = [...t.loops.values()].find((r) => !r.settled) || null;
        log(`loop end target=${t.key} id=${run.id} ${kind} dur=${human(run.endedAt - run.startedAt)}`);
    }
    /** 没开始就被拦下的一轮（会话已归档）：最早一条未开始的消息按失败收尾。 */
    function turnBlocked(sid) {
        const t = targetBySid(sid);
        const run = t && [...t.loops.values()].find((r) => !r.settled && !r.begun);
        if (!run) {
            log(`turn blocked sid=${String(sid).slice(0, 16)}（没有待开始的消息）`);
            return;
        }
        run.error = "会话已在 Desktop 里归档，这条消息没有执行。先在 Desktop 取消归档，或重发一次（会自动取消归档）";
        run.settle();
        t.noteSettled(run);
        log(`loop blocked target=${t.key} id=${run.id}`);
    }
    /** 插话并入了正在运行的这一轮：插话自己不再单独回传，这一轮改为结果推回手机。 */
    function turnMerge(sid, rpcId) {
        const t = targetBySid(sid);
        const run = t?.loops.get(rpcId);
        const cur = t?.turnRun;
        if (!run || run.settled || !cur || cur === run || cur.settled)
            return;
        run.begun = true;
        run.superseded = true;
        run.settle();
        if (rpcId.startsWith(PHONE_RPC_PREFIX)) {
            cur.local = false;
            cur.muted = false;
            watchAsync(t, cur);
        }
        log(`steer merged target=${t.key} id=${rpcId} into=${cur.id}`);
    }
    /** final=false 是 DSH 用首条消息截断的临时标题。 */
    function title(sid, name, final = true) {
        const t = targetBySid(sid);
        if (!t || !name || (t.titleFinal && !final))
            return;
        t.name = oneLine(name);
        if (final)
            t.titleFinal = true;
    }
    function modelSelected(sid, sel) {
        const t = targetBySid(sid);
        if (!t || !sel?.model)
            return;
        t.model = String(sel.model);
        t.modelProvider = String(sel.provider || "");
        t.thinkingLevel = sel.reasoningEffort ? String(sel.reasoningEffort) : "";
    }
    function ingest(sid, event) {
        const t = targetBySid(sid);
        if (t?.art)
            ingestEvent(t.art, event, t.cwd);
        if (t && event?.type === "goal/change")
            goalChanged(t, event.data);
    }
    /** 两轮之间目标结束（电脑上暂停、清除）：把压着的上一轮推出去；手机命令改的由命令自己回复。 */
    function goalChanged(t, d) {
        t.goal = d?.operation === "clear" ? null : goalView(d);
        const held = t.goalHeld;
        const cur = t.turnRun;
        if (!held || goalLive(t.goal) || t.goalCmd || (cur && !cur.settled && cur.trigger === "goal"))
            return;
        t.goalHeld = null;
        markGoalEnd(held, t.goal);
        log(`goal ended between rounds target=${t.key} ${t.goal?.phase || "cleared"}`);
        pushSettled(t, held);
    }
    /**
     * 审批 / 提问转手机：审批只管手机发起的轮次，提问不限轮次（模型提问时人可能已离开电脑）。
     * 返回 null 表示不接（电脑发起的审批、未运行、未绑定主人、企微断开），交回 Desktop。
     * answer 兑现为 openUiPrompt 的回答；遥控停止时兑现为 {detached:true}。done() 在 Desktop 先答时收回手机卡片。
     */
    function uiAsk(sid, req) {
        if (stopped || !started || !transport?.bound() || !transport.connected)
            return null;
        const t = targetBySid(sid);
        const run = t && pendingRun(t);
        // 电脑发起的审批只在「关注」后转手机：Desktop 关窗后任务还在跑，没人点审批。
        const followed = following && run?.watched && !run.muted;
        if (!run || (run.local && req.kind !== "question" && !followed))
            return null;
        const reqId = String(req.reqId);
        let reply;
        const answer = new Promise((res) => { reply = res; });
        if (!isBound(t)) {
            if (!uiPending.has(reqId) && !uiParked.has(reqId)) {
                const first = !hasParkedUi(t);
                uiParked.set(reqId, { t, req, reply });
                log(`ui parked (unbound) target=${t.key} kind=${req.kind}`);
                if (first && run.watched && !run.muted)
                    remindParkedUi(t);
            }
        }
        else
            openUiPrompt(t, req, reply);
        return {
            answer,
            done() {
                if (uiParked.get(reqId)?.t === t)
                    uiParked.delete(reqId);
                const e = uiPending.get(reqId);
                if (e && closeUiPrompt(e))
                    log(`ui answered on computer target=${t.key}`);
            },
        };
    }
    // ---- 生命周期 ----
    const intervals = new Set();
    function every(fn, ms) {
        const h = setInterval(fn, ms);
        h.unref?.();
        intervals.add(h);
    }
    // 插件可能先于 DSH 的会话服务就绪：失败时稍后重试。
    async function syncSessions(tries = SYNC_RETRIES) {
        let sessions = [];
        try {
            sessions = await host.listSessions();
        }
        catch (e) {
            if (tries > 1 && !stopped)
                later(() => void syncSessions(tries - 1), SYNC_RETRY_MS);
            else
                log(`session/list 失败：${e?.message || e}`);
            return;
        }
        for (const s of sessions) {
            if (stopped)
                return;
            if ((s.agentAvailable || s.running) && !s.sub)
                ensureTarget(s);
            else
                targetBySid(s.sessionId)?.applyInfo(s);
        }
    }
    function start() {
        if (started || stopped)
            return;
        started = true;
        loadCurrent();
        loadPhoneSessions();
        const opts = {
            config: CFG, dir: DIR, log,
            onMessage: handleCommand, onCard: handleCardCallback,
            onBind: (uid) => { saveOwner(DIR, uid); onConfigWritten(); },
            isBusy: () => [...targets.values()].some((t) => t.busy || t.running),
        };
        transport = createTransport ? createTransport(opts) : new WeComTransport(opts);
        transport.replaySpool?.(() => takeSpool(DIR), { ttlMs: SPOOL_TTL_MS, launched: () => takeLaunched(DIR) });
        transport.start();
        void syncSessions();
        every(() => {
            for (const t of targets.values()) {
                if (!t.running)
                    reapIdle(t);
                t.trimLoops();
            }
        }, IDLE_REAP_MS);
        log(`remote up v${VERSION} dir=${tilde(DIR)}` + (currentSessionId ? ` current=${currentSessionId.slice(0, 16)}` : ""));
    }
    /**
     * 停止：拒收新入站，未结束的轮次按中断收尾，等回执排进发件箱（有硬限）后断开。
     * notify：true 必发重启通知，false 不发；"auto" 只在手机端用得上时发（有推送中的任务被中断，或手机最近用过）。
     */
    async function stop(why = "遥控服务已停止", { notify = "auto" } = {}) {
        if (stopped)
            return;
        stopped = true;
        shuttingDown = why;
        if (notify === "auto") {
            const interrupted = [...targets.values()].some((t) => inflightRuns(t).some((r) => !r.muted));
            notify = interrupted || Date.now() - lastPhoneAt < RESTART_NOTICE_ACTIVE_MS;
        }
        log(`remote down (${why}) notify=${notify}`);
        transport?.drain({ notify });
        for (const h of intervals)
            clearInterval(h);
        for (const h of timers)
            clearTimeout(h);
        timers.clear();
        dropUiPrompts(null, { detached: true });
        const pending = [];
        for (const t of [...targets.values()]) {
            for (const r of inflightRuns(t)) {
                r.aborted = why;
                r.settle();
                pending.push(r.wait());
            }
            t.closed = true;
        }
        targets.clear();
        await Promise.race([
            Promise.allSettled(pending).then(() => delay(0)).then(() => Promise.allSettled([...inflightPushes])),
            delay(STOP_GRACE_MS),
        ]);
        transport?.stop();
    }
    return {
        start,
        stop,
        sessionSeen,
        sessionGone,
        sessionStatus,
        turnBegin,
        output,
        activity,
        turnEnd,
        turnBlocked,
        turnMerge,
        title,
        modelSelected,
        ingest,
        uiAsk,
        handleCommand,
        handleCardCallback,
        get stopped() { return stopped; },
        get transport() { return transport; },
        targets,
        busy: () => [...targets.values()].filter((t) => t.busy).map((t) => t.label()),
    };
}
