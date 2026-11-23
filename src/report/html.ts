/**
 * Single-file, dependency-free HTML report. All report data is embedded as
 * JSON and rendered by a small vanilla JS renderer - no external assets,
 * safe to open from disk or attach to a GitHub issue/email.
 */
import type { ScanReport } from '../types.js';

export function renderHtml(report: ScanReport): string {
  const json = JSON.stringify(report).replace(/</g, '\\u003c');
  const seal = sealFor(report);
  const bars = fingerprintBars(json, seal);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ChangeGuard 报告 — ${escapeHtml(report.repoName)}</title>
<style>
  /* Sonar · 深底（默认） */
  :root { --bg:#0d0a14; --deep:#080610; --card:#161022; --line:#2c2340; --fg:#efeaf8; --mut:#a79cc4;
          --high:#ff5d6c; --med:#ffb454; --low:#948db0; --acc:#a78bfa; --acc-2:#7c3aed; --ok:#b9a6ff; }
  /* Sonar · 亮底 v1（深紫 700） */
  [data-theme="sonar-light"] { --bg:#faf9fd; --deep:#f0edf7; --card:#ffffff; --line:#e5e1ef; --fg:#1a1330; --mut:#6b6188;
          --high:#dc2626; --med:#b45309; --low:#64748b; --acc:#6d28d9; --acc-2:#7c3aed; --ok:#059669; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); background-image:radial-gradient(1100px 520px at 75% -12%,rgba(124,58,237,.18),transparent 60%),linear-gradient(rgba(167,139,250,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(167,139,250,.05) 1px,transparent 1px); background-size:auto,28px 28px,28px 28px; color:var(--fg); font:14px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { position:relative; padding:26px 32px 16px; border-bottom:1px solid var(--line); border-top:2px solid var(--acc); background:var(--deep); }
  h1 { margin:0 0 6px; font-size:19px; font-family:ui-monospace,"Cascadia Code",Consolas,monospace; letter-spacing:.02em; }
  .sub { color:var(--mut); font-size:13px; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 32px 64px; }
  /* 火漆章：右上旋转双线描边图章 */
  .seal { position:absolute; top:20px; right:28px; transform:rotate(-6deg); font:700 15px/1 ui-monospace,"Cascadia Code",Consolas,monospace; letter-spacing:.14em; padding:9px 14px; border:1px solid currentColor; border-radius:4px; box-shadow:inset 0 0 0 3px var(--deep), inset 0 0 0 4px currentColor; text-transform:uppercase; opacity:.92; }
  .seal.h { color:var(--high); } .seal.m { color:var(--med); } .seal.l { color:var(--low); } .seal.c { color:var(--ok); }
  /* 风险标尺：数字读数条（无卡片） */
  .readline { display:flex; gap:26px; flex-wrap:wrap; align-items:baseline; font-family:ui-monospace,"Cascadia Code",Consolas,monospace; margin:20px 0 24px; border-bottom:1px solid var(--line); padding-bottom:14px; }
  .readline span { display:inline-flex; align-items:baseline; gap:5px; }
  .readline b { font-size:24px; font-weight:700; color:var(--fg); }
  .readline em { font-style:normal; color:var(--mut); font-size:12px; letter-spacing:.06em; }
  .rh b{color:var(--high)} .rm b{color:var(--med)} .rl b{color:var(--low)} .ra b{color:var(--acc)}
  .toolbar { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:18px; }
  .toolbar button { background:none; border:none; color:var(--mut); padding:4px 2px; cursor:pointer; font:600 13px ui-monospace,"Cascadia Code",Consolas,monospace; letter-spacing:.06em; }
  .toolbar button::before { content:'[ '; color:var(--mut); }
  .toolbar button::after { content:' ]'; color:var(--mut); }
  .toolbar button:hover { color:var(--fg); }
  .toolbar button.active { color:var(--acc); }
  .toolbar button.active::before, .toolbar button.active::after { color:var(--acc); }
  .signo { color:var(--acc); font-family:ui-monospace,Consolas,monospace; font-size:12px; letter-spacing:.06em; }
  details { background:var(--card); border:1px solid var(--line); border-radius:4px; margin-bottom:12px; overflow:hidden; }
  summary { padding:14px 18px; cursor:pointer; font-weight:600; list-style:none; display:flex; gap:10px; align-items:center; }
  summary::-webkit-details-marker { display:none; }
  .finding { border-top:1px solid var(--line); padding:16px 18px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:11px; font-weight:700; letter-spacing:.04em; font-family:ui-monospace,Consolas,monospace; }
  .b-high { background:rgba(255,93,108,.15); color:var(--high); }
  .b-medium { background:rgba(255,180,84,.15); color:var(--med); }
  .b-low { background:rgba(148,141,176,.2); color:var(--low); }
  .rule { color:var(--acc); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
  .loc { color:var(--mut); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
  .path { font-family:ui-monospace,Menlo,Consolas,monospace; color:#c4b5fd; }
  .meta { color:var(--mut); font-size:13px; margin:6px 0; }
  pre { background:var(--deep); border:1px solid var(--line); border-radius:4px; padding:10px 12px; overflow-x:auto; font-size:12.5px; margin:10px 0; }
  pre.diff { color:#c8d3e8; }
  .steps { margin:8px 0 0; padding-left:20px; }
  .steps li { margin:3px 0; }
  a { color:var(--acc); }
  .tag { background:var(--deep); border:1px solid var(--line); border-radius:3px; padding:1px 7px; font-size:11px; color:var(--mut); }
  .cm { color:var(--ok); font-size:12.5px; }
  .ai-note { display:inline-block; background:rgba(167,139,250,.12); color:var(--acc); border:1px solid var(--acc); border-radius:3px; padding:1px 7px; font-size:11px; font-weight:600; margin-left:6px; vertical-align:middle; }
  footer { color:var(--mut); font-size:12px; margin-top:28px; text-align:center; }
  .barcode { display:flex; align-items:flex-end; justify-content:center; gap:2px; height:26px; margin-bottom:10px; }
  .barcode i { width:1px; background:var(--mut); opacity:.75; }
  .fpid { font-family:ui-monospace,Consolas,monospace; font-size:10px; letter-spacing:.2em; color:var(--mut); margin-bottom:6px; }
  .dep { display:inline-block; margin:2px 6px 2px 0; }
</style>
</head>
<body>
<header>
  <div class="seal ${seal.cls}">${seal.text}</div>
  <h1>DISPATCH ▸ 影响简报 — ${escapeHtml(report.repoName)}</h1>
  <div class="sub">${escapeHtml(report.generatedAt)} · 模式 ${report.mode} · 变更起始 ${escapeHtml(report.since ?? '-')}</div>
</header>
<div class="wrap">
  <div class="readline">
    <span class="rh"><b>${report.summary.high}</b><em>高风险</em></span>
    <span class="rm"><b>${report.summary.medium}</b><em>中风险</em></span>
    <span class="rl"><b>${report.summary.low}</b><em>低风险</em></span>
    <span class="ra"><b id="c-total">0</b><em>影响发现</em></span>
    <span><b>${report.summary.filesAffected}</b><em>涉及文件</em></span>
    <span><b>${report.callSiteCount}</b><em>调用点</em></span>
  </div>
  <div class="toolbar" id="filters">
    <button data-f="all" class="active">ALL</button>
    <button data-f="high">HIGH</button>
    <button data-f="codemod">AUTO-FIX</button>
  </div>
  <div id="root"></div>
  <footer>
    <div class="barcode" aria-hidden="true">${bars}</div>
    <div class="fpid">FP · ${escapeHtml(seal.fp)}</div>
    影响判定全部来自确定性规则（Tree-sitter AST × OpenAPI diff × 版本约束）。LLM 仅负责文字解释，不参与任何影响判定。
  </footer>
</div>
<script id="report-data" type="application/json">${json}</script>
<script>
const report = JSON.parse(document.getElementById('report-data').textContent);
const sevClass = s => 'b-' + s;
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
document.getElementById('c-total').textContent = report.summary.total;

let sigSeq = 0;
function findingHtml(f) {
  const signo = '<span class="signo">SIG-' + String(++sigSeq).padStart(4, '0') + '</span>';
  const expl = f.explanation
    ? '<div class="meta">'
      + esc(f.explanation.summary)
      + (f.explanation.source === 'llm'
        ? ' <span class="ai-note">🤖 AI 生成，仅供参考</span>' : '')
      + '</div>'
    : (f.change.summary ? '<div class="meta">' + esc(f.change.summary) + '</div>' : '');
  let steps = '';
  const stepList = f.explanation?.migrationSteps?.length ? f.explanation.migrationSteps
    : (f.change.migration ? [f.change.migration] : []);
  if (stepList.length) steps = '<ol class="steps">' + stepList.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  const snip = f.codeSnippet ? '<pre><code>' + esc(f.codeSnippet) + '</code></pre>' : '';
  const loc = f.file ? '<span class="loc">' + esc(f.file) + ':' + (f.line ?? '?') + '</span>'
                      + (f.callPath ? ' · <span class="path">' + esc(f.callPath) + '</span>' : '')
                    : '<span class="loc">仓库级（依赖版本/公告）</span>';
  const cm = f.codemod ? '<div class="cm">🛠 可自动修复：<code>' + esc(f.codemod.from) + '</code> → <code>' + esc(f.codemod.to) + '</code></div>' : '';
  const url = f.change.sourceUrl ? ' · <a href="' + esc(f.change.sourceUrl) + '" target="_blank" rel="noopener">厂商公告</a>' : '';
  return '<div class="finding" data-sev="' + f.severity + '" data-cm="' + (f.codemod?'1':'0') + '">'
    + signo + ' '
    + '<span class="badge ' + sevClass(f.severity) + '">' + f.severity.toUpperCase() + '</span> '
    + '<span class="rule">' + f.ruleId + '/' + f.match + '</span> '
    + '<strong>' + esc(f.change.title) + '</strong>'
    + '<div class="meta">' + loc + ' · 置信度 ' + f.confidence + url + '</div>'
    + expl + steps + cm + snip + '</div>';
}

const groups = {};
for (const f of report.findings) (groups[f.providerId] ||= []).push(f);
const root = document.getElementById('root');
root.innerHTML = Object.keys(groups).sort().map(pid => {
  const fs = groups[pid];
  return '<details open><summary><span class="badge b-high">' + fs.length + '</span> ' + pid
    + ' <span class="tag">' + esc(fs[0].change.kind) + '</span></summary>'
    + fs.map(findingHtml).join('') + '</details>';
}).join('');

document.getElementById('filters').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  document.querySelectorAll('#filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const f = btn.dataset.f;
  document.querySelectorAll('.finding').forEach(el => {
    el.style.display = (f === 'all') || (f === 'high' && el.dataset.sev === 'high')
      || (f === 'codemod' && el.dataset.cm === '1') ? '' : 'none';
  });
});
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/** 火漆章：最高严重度 + 计数；零发现显示 CLEAN。 */
function sealFor(report: ScanReport): { cls: string; text: string; fp: string } {
  const s = report.summary;
  if (s.high > 0) return { cls: 'h', text: `HIGH · ${s.high}`, fp: '' };
  if (s.medium > 0) return { cls: 'm', text: `MED · ${s.medium}`, fp: '' };
  if (s.low > 0) return { cls: 'l', text: `LOW · ${s.low}`, fp: '' };
  return { cls: 'c', text: 'CLEAN · PASS', fp: '' };
}

/** 指纹条码：按报告 JSON 的 FNV-1a 链式哈希按位生成 1px 竖线（确定性，零 JS）。 */
function fingerprintBars(json: string, seal: { fp: string }): string {
  const words: number[] = [];
  let h = 0x811c9dc5;
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < json.length; i++) {
      h ^= (json.charCodeAt(i) + round * 0x9e3779b9) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    words.push(h >>> 0);
  }
  seal.fp = words
    .slice(0, 2)
    .map((w) => w.toString(16).padStart(8, '0'))
    .join('')
    .toUpperCase();
  const bars: string[] = [];
  for (const w of words) {
    for (let b = 0; b < 8; b++) {
      const on = (w >>> b) & 1;
      const height = on ? 8 + ((w >>> (b + 2)) % 18) : 5;
      bars.push(`<i style="height:${height}px"></i>`);
    }
  }
  return bars.join('');
}
