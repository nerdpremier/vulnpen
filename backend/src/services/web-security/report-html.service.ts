/**
 * The client report as a print-ready document.
 *
 * The .docx (report-docx.service.ts) is the working copy: it is what the tester
 * opens in Collabora, rewrites and signs off. This module is the *deliverable*
 * — the same findings rendered as an A4 document with a cover, a table of
 * contents, a one-page card per finding and a remediation plan. Word cannot
 * express that layout (no grids, no per-page cards, no computed page numbers in
 * a TOC), so the PDF is rendered from HTML by a real browser instead
 * (report-pdf.service.ts) and the .docx stays the editable artefact.
 *
 * Everything here is derived from the session's own records: the counts are
 * recomputed, the OWASP split comes from the findings, the plan groups the
 * findings the report already lists. Nothing is invented — a section that has
 * no data behind it is left out rather than filled with boilerplate.
 *
 * The font is embedded (base64) rather than named: the backend image ships no
 * Thai system font, so a `font-family: 'TH Sarabun PSK'` alone would render the
 * whole document as tofu. See assets/fonts.
 */
import fs from "fs";
import path from "path";
import type { ClientFinding, ClientReport } from "./client-report.service";
import type { ReportStats } from "./report.service";

export interface ReportHtmlContext {
  /** Target as printed on the cover, e.g. "https://10.0.0.5/app/". */
  target?: string;
  scope?: string;
  client?: string;
  tester?: string;
  testingWindow?: string;
  version?: string;
  testType?: string;
  tools?: string[];
  limitations?: string;
  generatedAt: Date;
  stats: ReportStats;
}

interface LevelStyle {
  key: "critical" | "high" | "medium" | "low" | "info";
  en: string;
  color: string;
  bg: string;
}

/** The five bands the document prints, keyed by the Thai level the report carries. */
const LEVEL: Record<string, LevelStyle> = {
  วิกฤต: { key: "critical", en: "Critical", color: "#b3261e", bg: "#fbeceb" },
  สูง: { key: "high", en: "High", color: "#c2410c", bg: "#fdf0e6" },
  ปานกลาง: { key: "medium", en: "Medium", color: "#a16207", bg: "#fbf4e0" },
  ต่ำ: { key: "low", en: "Low", color: "#0f766e", bg: "#e7f4f2" },
  ข้อมูลข่าวสาร: { key: "info", en: "Informational", color: "#475569", bg: "#eef1f5" },
  ไม่ได้ประเมิน: { key: "info", en: "Not rated", color: "#475569", bg: "#eef1f5" },
};

const level = (finding: ClientFinding): LevelStyle => LEVEL[finding.risk] ?? LEVEL["ข้อมูลข่าวสาร"];

const FONT_DIR = path.join(__dirname, "../../../assets/fonts");
const FONT_STACK = "'THSarabunPSK','Leelawadee UI',Tahoma,sans-serif";

/** Print margins in mm — the cover page overrides them to zero (see CSS). */
const MARGIN = { top: 17, right: 14, bottom: 15, left: 14 };
const PAGE_MARGIN = `${MARGIN.top}mm ${MARGIN.right}mm ${MARGIN.bottom}mm ${MARGIN.left}mm`;

/**
 * The text block a normal page gets, in mm. The renderer lays the document out
 * at exactly this width before printing so that measuring a section's height
 * tells it which page that section lands on (see report-pdf.service.ts).
 */
export const PAGE_BOX = {
  widthMm: 210 - MARGIN.left - MARGIN.right,
  heightMm: 297 - MARGIN.top - MARGIN.bottom,
};

let facesCache: string | null = null;

/** The two weights the document uses, inlined so the PDF needs no installed font. */
function fontFaces(): string {
  if (facesCache) return facesCache;
  const read = (file: string) => {
    const buffer = fs.readFileSync(path.join(FONT_DIR, file));
    return buffer.toString("base64");
  };
  const regular = read("THSarabunPSK-Regular.ttf");
  const bold = read("THSarabunPSK-Bold.ttf");
  facesCache =
    "@font-face{font-family:'THSarabunPSK';font-style:normal;font-weight:400;font-display:block;" +
    `src:url("data:font/ttf;base64,${regular}") format('truetype');}\n` +
    "@font-face{font-family:'THSarabunPSK';font-style:normal;font-weight:700;font-display:block;" +
    `src:url("data:font/ttf;base64,${bold}") format('truetype');}\n`;
  return facesCache;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A command, a URL or a raw response reads better in monospace than as prose.
 * Only the leading verb is matched: a sentence that merely mentions `curl`
 * stays a sentence.
 */
const COMMAND =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|curl|wget|nmap|mysql|psql|sqlmap|nuclei|ffuf|gobuster|dirb|hydra|hashcat|john|nc|ncat|openssl|dig|whois|nikto|msfconsole|python3?|bash|sh|node|docker|git)\b/i;

function inline(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Steps are recorded as "the request -> what it proved". Only the request is a
 * code run: the explanation is Thai prose, and Thai in a monospace run prints at
 * 9.9pt in a face that has no business rendering prose. The same applies to a
 * note recorded on the command line itself, so the run stops at the first Thai
 * character.
 */
const ARROW = /\s*(?:->|=>|→)\s*/;
const THAI_CHAR = /[\u0E00-\u0E7F]/;

function richLine(text: string): string {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  const [head, ...rest] = trimmed.split(ARROW);
  const command = head.trim();
  if (COMMAND.test(command) || /^[A-Z]{3,7}\s+\//.test(command)) {
    const thai = command.search(THAI_CHAR);
    const code = thai > 0 ? command.slice(0, thai).trim() : command;
    const prose = [thai > 0 ? command.slice(thai).trim() : "", rest.join(" -> ").trim()]
      .filter(Boolean)
      .join(" → ");
    return `<code>${esc(code)}</code>${prose ? ` <i class="arrow">→</i> ${inline(prose)}` : ""}`;
  }
  return inline(trimmed);
}

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function thaiDate(value?: Date): string {
  const date = value ?? new Date();
  return `${date.getDate()} ${THAI_MONTHS[date.getMonth()]} ${date.getFullYear() + 543}`;
}

/** The big line on the cover: the host, not the full URL — it has to stay legible. */
function headlineOf(target?: string): string | undefined {
  if (!target) return undefined;
  const value = target.trim();
  const withoutScheme = value.replace(/^[a-z]+:\/\//i, "");
  const host = withoutScheme.split("/")[0];
  return host || value;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * TH Sarabun PSK is drawn small for its point size — roughly two thirds of a
 * normal text face. The sizes below are the report's own scale *after* that
 * correction (body 15pt, headings 24pt), so the printed page reads at the
 * weight a Thai office document expects.
 */
const CSS = `
:root{
  --ink:#101a26; --ink2:#2d3f52; --muted:#69798c; --faint:#93a2b3;
  --rule:#dde4ec; --rule2:#eef2f7; --panel:#f6f8fb;
  --navy:#0e2136; --accent:#1f4e79; --gold:#b78b2c;
}
/* The page geometry lives here, not in the renderer's options: Chromium only
   honours a per-page margin override when the margins come from CSS (named
   pages), and that override is the whole reason the cover can bleed to the
   paper edge while every other page keeps its margins and running footer. */
@page{size:A4;margin:${PAGE_MARGIN};}
@page cover{margin:0;}
*{box-sizing:border-box;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{margin:0;font-family:${FONT_STACK};font-size:15pt;line-height:1.31;color:var(--ink);}
h1,h2,h3,h4{margin:0;font-weight:700;line-height:1.12;}
p{margin:0 0 7px;}
code{font-family:'Consolas','DejaVu Sans Mono','THSarabunPSK',monospace;font-size:9.9pt;background:#eef2f7;
  border:1px solid #e2e8f0;border-radius:2px;padding:.5px 3px;color:#17324d;word-break:break-word;}
i.arrow{font-style:normal;color:var(--faint);font-size:12.4pt;}
.pagebreak{break-before:page;}

/* section header */
.sec-head{display:flex;align-items:flex-end;gap:10px;border-bottom:1.5px solid var(--navy);
  padding-bottom:5px;margin-bottom:9px;}
.sec-head .kicker{font-size:11.4pt;letter-spacing:.22em;color:var(--gold);font-weight:700;
  text-transform:uppercase;padding-bottom:3px;}
.sec-head h2{font-size:24pt;color:var(--navy);letter-spacing:-.01em;}
.sec-head .no{margin-left:auto;font-size:11.4pt;letter-spacing:.12em;color:var(--faint);font-weight:600;}

/* cover */
.cover{page:cover;position:relative;width:210mm;height:297mm;overflow:hidden;color:#e9f0f8;
  background:radial-gradient(120% 90% at 78% 8%,#1d4162 0%,#132c47 42%,#0b1a2b 100%);}
.cover .grid{position:absolute;inset:0;opacity:.16;
  background-image:linear-gradient(to right,rgba(255,255,255,.22) 1px,transparent 1px),
                   linear-gradient(to bottom,rgba(255,255,255,.22) 1px,transparent 1px);
  background-size:14mm 14mm;}
.cover .glow{position:absolute;width:150mm;height:150mm;border-radius:50%;right:-52mm;top:-40mm;
  background:radial-gradient(circle,rgba(183,139,44,.30) 0%,rgba(183,139,44,0) 66%);}
.cover .ring{position:absolute;border-radius:50%;border:1px solid rgba(233,240,248,.14);}
.cover .ring.a{width:118mm;height:118mm;right:-30mm;top:-16mm;}
.cover .ring.b{width:170mm;height:170mm;right:-56mm;top:-42mm;}
.cover-inner{position:relative;padding:24mm 20mm 20mm;height:100%;display:flex;flex-direction:column;}
.cover-top{display:flex;justify-content:space-between;align-items:center;font-size:11.7pt;
  letter-spacing:.2em;text-transform:uppercase;color:#a9bed4;}
.cover-top .brand{font-weight:700;letter-spacing:.34em;color:#e9f0f8;}
.cover-top .brand span{color:var(--gold);}
.cover-mid{margin-top:34mm;}
.cover-eyebrow{font-size:14.4pt;letter-spacing:.04em;color:#a9bed4;margin-bottom:9mm;font-weight:500;}
.cover h1{font-size:74pt;line-height:.98;letter-spacing:-.02em;color:#fff;margin:0 0 2mm;
  word-break:break-word;}
.cover-rule{width:34mm;height:2.5px;background:var(--gold);margin:6mm 0;}
.cover-sub{font-size:26pt;font-weight:600;color:#dce7f2;letter-spacing:-.01em;}
.cover-lede{margin-top:9mm;max-width:120mm;font-size:14.4pt;line-height:1.42;color:#a9bed4;}
.cover-sevwrap{margin-top:11mm;}
.csev-label{font-size:10.4pt;letter-spacing:.16em;text-transform:uppercase;color:#8ba3bc;
  font-weight:600;margin-bottom:3mm;}
.cover-sev{display:flex;gap:7mm;}
.csev{display:flex;align-items:center;gap:2.6mm;font-size:13.6pt;color:#c9d8e6;}
.csev i{width:2.6mm;height:2.6mm;border-radius:50%;display:inline-block;}
.csev b{font-size:17pt;font-weight:700;color:#fff;}
.cover-meta{margin-top:22mm;display:grid;grid-template-columns:repeat(4,1fr);gap:0;
  border-top:1px solid rgba(233,240,248,.22);padding-top:6mm;}
.cover-meta>div{display:flex;flex-direction:column;gap:2px;padding-right:6mm;}
.cover-meta span{font-size:10.8pt;letter-spacing:.14em;text-transform:uppercase;color:#8ba3bc;}
.cover-meta strong{font-size:16.5pt;font-weight:600;color:#e9f0f8;}
.cover-fine{margin-top:auto;display:flex;justify-content:space-between;align-items:center;
  border-top:1px solid rgba(233,240,248,.14);padding-top:4mm;font-size:10.6pt;color:#7b93ad;}

/* text */
.lede{font-size:16.2pt;line-height:1.36;color:var(--ink2);}
.note{font-size:12.9pt;color:var(--muted);}
.hr{height:1px;background:var(--rule);margin:7px 0;}
.callout{background:#fdf6f5;border:1px solid #f1dbd8;border-left:3px solid #b3261e;
  padding:2.6mm 4mm;margin:0 0 3.6mm;break-inside:avoid;}
.callout .ck{font-size:11.4pt;letter-spacing:.14em;text-transform:uppercase;color:#b3261e;
  font-weight:700;margin-bottom:1.4mm;}
.callout .ct{font-size:14.4pt;line-height:1.28;color:#3a2b2a;}

/* stat tiles */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:3mm;margin:3.4mm 0 4mm;break-inside:avoid;}
.stat{border:1px solid #cfd9e4;border-top:3px solid var(--sev);background:#fbfcfe;
  padding:4mm 3mm 3mm;border-radius:2px;break-inside:avoid;}
.stat .n{font-size:34pt;font-weight:700;line-height:1.12;color:var(--sev);margin-top:1mm;}
.stat .l{font-size:12.6pt;color:var(--ink2);margin-top:1.6mm;font-weight:600;}
.stat .e{font-size:10.2pt;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);}

/* bars */
.bars{display:flex;flex-direction:column;gap:2.6mm;}
.bar{display:grid;grid-template-columns:23mm 1fr 17mm;align-items:center;gap:3mm;font-size:13.2pt;}
.bar .lb{color:var(--ink2);font-weight:600;}
.bar .track{height:4.6mm;background:var(--rule2);border-radius:1px;overflow:hidden;}
.bar .fill{height:100%;background:var(--sev);}
.bar .vl{text-align:right;color:var(--muted);font-size:12.6pt;white-space:nowrap;}

/* owasp grid */
.owasp-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 7mm;}
.or{display:grid;grid-template-columns:1fr 7mm;align-items:baseline;gap:2mm;padding:1.3mm 0;
  border-bottom:1px solid var(--rule2);font-size:11.9pt;line-height:1.15;}
.or .ol b{font-weight:700;color:var(--navy);margin-right:1.8mm;letter-spacing:.02em;}
.or .ol{color:var(--ink2);}
.or .on{text-align:right;font-weight:700;color:var(--navy);}

/* panels + tables */
.panel{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:4mm 5mm;
  break-inside:avoid;}
.panel h4{font-size:14.4pt;color:var(--navy);margin-bottom:2mm;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:6mm;}
table{border-collapse:collapse;width:100%;}
.tbl th{font-size:11.4pt;letter-spacing:.12em;text-transform:uppercase;color:#7b8a9c;text-align:left;
  padding:0 3mm 2mm;border-bottom:1.5px solid var(--navy);font-weight:700;}
.tbl td{padding:1.75mm 3mm;border-bottom:1px solid var(--rule);font-size:13pt;vertical-align:top;
  line-height:1.25;}
.tbl tr{break-inside:avoid;}
.tbl tr:last-child td{border-bottom:none;}
.tbl .num{font-variant-numeric:tabular-nums;color:var(--faint);font-size:12.6pt;width:9mm;}
.tbl .cv{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap;}
.tbl .id{font-size:11.4pt;color:var(--muted);margin-top:.4mm;}
.kv{width:100%;}
.kv td{padding:1.7mm 0;border-bottom:1px solid var(--rule2);font-size:13.5pt;vertical-align:top;}
.kv td:first-child{width:38mm;color:var(--muted);font-size:12.9pt;}
.risk td{font-size:12.4pt;line-height:1.3;padding:1.8mm 2.6mm;}
.risk td:nth-child(2){white-space:nowrap;font-family:'Consolas',monospace;font-size:11.6pt;
  color:var(--ink2);}

/* severity chip */
.chip{display:inline-flex;align-items:center;gap:1.6mm;font-size:11.7pt;font-weight:700;
  color:var(--sev);background:var(--sevb);border-radius:2px;padding:1px 2.2mm;white-space:nowrap;}
.chip i{width:1.8mm;height:1.8mm;border-radius:50%;background:var(--sev);display:inline-block;}

/* toc */
.toc{margin-top:2mm;}
.toc-row{display:flex;align-items:baseline;gap:2mm;font-size:12.4pt;padding:.5mm 0;
  border-bottom:1px dotted #e3e9f1;line-height:1.12;}
.toc-row .t{flex:1;color:var(--ink2);}
.toc-row .t b{color:var(--faint);font-weight:600;font-size:12pt;margin-right:2.4mm;
  font-variant-numeric:tabular-nums;}
.toc-row .p{color:var(--muted);font-size:12.6pt;font-variant-numeric:tabular-nums;}
.toc-row .dot{width:2.2mm;height:2.2mm;border-radius:50%;background:var(--sev);flex:0 0 auto;
  margin-right:2mm;display:inline-block;}
.toc-row .dot.none{background:#dfe6ee;}
.toc-row.grp{border-bottom:none;padding-top:3mm;font-size:11.4pt;letter-spacing:.18em;
  text-transform:uppercase;color:var(--gold);font-weight:700;}
.toc-legend{display:flex;align-items:center;gap:5mm;margin-top:8mm;padding-top:4mm;
  border-top:1px solid var(--rule);}
.toc-legend .tl{font-size:11pt;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);
  font-weight:700;}
.toc-legend .tlc{display:inline-flex;align-items:center;gap:2mm;font-size:12.4pt;color:var(--ink2);}
.toc-legend .tlc i{width:2.2mm;height:2.2mm;border-radius:50%;background:var(--sev);
  display:inline-block;}
.toc-legend .tln{margin-left:auto;font-size:11.6pt;color:var(--faint);}

/* finding card */
.finding{break-before:page;padding:0 0 7mm;margin:0 0 8mm;}
.f-head{display:flex;align-items:flex-start;gap:5mm;padding-bottom:3.2mm;
  border-bottom:1px solid var(--rule);}
.f-badge{flex:0 0 auto;width:16mm;height:16mm;border-radius:2px;background:var(--sevb);
  display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--sev);}
.f-badge .n{font-size:22.5pt;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;}
.f-badge .s{font-size:9.3pt;letter-spacing:.1em;text-transform:uppercase;font-weight:700;opacity:.85;}
.f-title{flex:1;padding-top:1mm;}
.f-title h3{font-size:20.1pt;color:var(--navy);letter-spacing:-.005em;text-wrap:balance;}
.f-sevbox{flex:0 0 auto;text-align:right;padding-top:.5mm;}
.f-sevbox .score{display:block;font-size:30pt;font-weight:700;line-height:1;color:var(--sev);
  font-variant-numeric:tabular-nums;}
.f-sevbox .lbl{display:block;font-size:12.6pt;color:var(--ink2);font-weight:600;margin-top:2.2mm;
  line-height:1.2;padding-right:.6mm;}
.meter{width:26mm;height:1.8mm;background:var(--rule2);margin:2.2mm 0 0 auto;border-radius:1px;
  overflow:hidden;}
.meter i{display:block;height:100%;background:var(--sev);}
.f-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:0 7mm;margin:3.4mm 0 4mm;
  border-left:2px solid var(--rule);padding-left:4mm;}
.f-meta .row{display:grid;grid-template-columns:24mm 1fr;gap:2mm;padding:1.2mm 0;
  border-bottom:1px solid var(--rule2);font-size:12.9pt;}
.f-meta .k{color:var(--faint);font-size:11.1pt;letter-spacing:.1em;text-transform:uppercase;
  padding-top:.6mm;font-weight:600;}
.f-meta .v{color:var(--ink2);}
.f-meta .v.vec{font-family:'Consolas',monospace;font-size:11.7pt;color:var(--muted);
  word-break:break-all;}

/* cvss metric chips */
.cvss{margin:4mm 0 1mm;break-inside:avoid;}
.cvss .cap{font-size:10.5pt;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);
  font-weight:700;margin-bottom:1.8mm;}
.cvss .grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2mm;}
.met{border:1px solid var(--rule);border-top:2px solid #cfd9e4;background:#fff;padding:1.8mm 2mm 2mm;}
.met .k{font-size:9.6pt;letter-spacing:.1em;color:var(--faint);font-weight:700;text-transform:uppercase;}
.met .v{font-size:12.3pt;font-weight:700;color:var(--navy);margin-top:.6mm;line-height:1.2;}
.met.hi{border-top-color:var(--sev);}
.met.hi .v{color:var(--sev);}
.met.no{border-top-color:#dbe3ec;}
.met.no .v{color:#8b9aab;font-weight:600;}

/* finding sections */
.f-sec{margin-top:4.4mm;}
.f-sec h4{display:flex;align-items:center;gap:2.4mm;font-size:16pt;color:var(--navy);
  letter-spacing:.02em;margin-bottom:1.8mm;}
.f-sec h4::before{content:'';width:3mm;height:3mm;background:var(--sev);border-radius:1px;
  flex:0 0 auto;}
.f-sec p{font-size:14.85pt;line-height:1.32;}
.f-sec.fix h4::before{background:var(--accent);}
.f-sec.fix .box{background:#f3f7fb;border:1px solid #dbe6f1;border-left:3px solid var(--accent);
  padding:3mm 4mm;border-radius:2px;}
.f-sec.fix p{margin:0;color:var(--ink2);}
.steps{margin:0;padding:0;list-style:none;counter-reset:s;}
.steps li{position:relative;padding-left:7mm;margin-bottom:1.8mm;font-size:14.55pt;line-height:1.28;}
.steps li::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:.2mm;
  width:4.4mm;height:4.4mm;border-radius:50%;background:var(--sev);color:#fff;font-size:10.2pt;
  font-weight:700;display:flex;align-items:center;justify-content:center;}
.ev{background:#f7f9fc;border:1px solid #e3e9f1;border-radius:2px;padding:3mm 4mm;
  font-size:13.5pt;line-height:1.3;color:var(--ink2);position:relative;word-break:break-word;}
.ev .tag{position:absolute;right:0;top:0;font-size:9.6pt;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint);font-weight:700;background:#eef3f9;padding:1px 2mm;border-bottom-left-radius:2px;}
.ev p{margin:0 0 3px;}
.ev p:last-child{margin:0;}

/* roadmap */
.road{display:grid;grid-template-columns:repeat(3,1fr);gap:3.5mm;margin-top:1mm;}
.road .col{border:1px solid var(--rule);border-radius:2px;overflow:hidden;break-inside:avoid;}
.road .col .hd{padding:2.4mm 3.2mm;background:var(--panel);border-bottom:1px solid var(--rule);}
.road .col .hd .w{font-size:10.2pt;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);
  font-weight:700;}
.road .col .hd .t{font-size:14.4pt;font-weight:700;color:var(--navy);line-height:1.16;}
.road .col .bd{padding:3mm 3.2mm;font-size:12.8pt;color:var(--ink2);line-height:1.3;}
/* One line each, ellipsised: the appendix is a checklist, and letting a long
   title run to three lines is what pushed the roadmap onto a third page. The
   full titles are one page back, in the findings index. */
.road .col .bd ul{margin:0;padding:0;list-style:none;}
.road .col .bd li{display:flex;gap:1.8mm;margin-bottom:1mm;}
.road .col .bd li b{flex:0 0 auto;color:var(--faint);font-weight:600;font-size:11.4pt;padding-top:.4mm;}
.road .col .bd li .cl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.road .col .bd .empty{color:var(--faint);}
.footer-note{margin-top:6mm;border-top:1px solid var(--rule);padding-top:3mm;font-size:12pt;
  color:var(--faint);}
`;

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

const sevVars = (style: LevelStyle) => `--sev:${style.color};--sevb:${style.bg};`;

const SEVERITY_ORDER: Array<[string, string, string]> = [
  ["วิกฤต", "Critical", "critical"],
  ["สูง", "High", "high"],
  ["ปานกลาง", "Medium", "medium"],
  ["ต่ำ", "Low", "low"],
  ["ข้อมูลข่าวสาร", "Informational", "info"],
];

function statTiles(stats: ReportStats): string {
  return `<div class="stats">${SEVERITY_ORDER.map(([th, en, key]) => {
    const style = LEVEL[th];
    const count = stats.bySeverity[key as keyof ReportStats["bySeverity"]] ?? 0;
    return `<div class="stat" style="${sevVars(style)}">
      <div class="n">${count}</div><div class="l">${th}</div><div class="e">${en}</div></div>`;
  }).join("")}</div>`;
}

function severityBars(stats: ReportStats): string {
  const counts = SEVERITY_ORDER.map(([th, , key]) => ({
    th,
    style: LEVEL[th],
    n: stats.bySeverity[key as keyof ReportStats["bySeverity"]] ?? 0,
  }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  return `<div class="bars">${counts
    .map(
      (c) => `<div class="bar" style="${sevVars(c.style)}">
      <div class="lb">${c.th}</div>
      <div class="track"><div class="fill" style="width:${(c.n / max) * 100}%"></div></div>
      <div class="vl">${c.n} รายการ</div></div>`,
    )
    .join("")}</div>`;
}

/** The OWASP split the findings themselves carry — not a second mapping. */
function owaspSplit(findings: ClientFinding[]): Array<{ id: string; label: string; n: number }> {
  const map = new Map<string, { id: string; label: string; n: number }>();
  for (const finding of findings) {
    const match = /^(A\d{2}):(\d{4})\s*(.*)$/.exec(finding.owasp);
    const id = match ? match[1] : "ไม่ระบุ";
    const label = match ? match[3] : finding.owasp;
    const entry = map.get(id) ?? { id, label, n: 0 };
    entry.n += 1;
    map.set(id, entry);
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

const CVSS_TH: Record<string, Record<string, string>> = {
  AV: { N: "เครือข่าย", A: "ข้างเคียง", L: "ท้องถิ่น", P: "กายภาพ" },
  AC: { L: "ต่ำ", H: "สูง" },
  PR: { N: "ไม่ต้อง", L: "ต่ำ", H: "สูง" },
  UI: { N: "ไม่ต้อง", R: "ต้องมี" },
  S: { U: "คงเดิม", C: "เปลี่ยน" },
  C: { H: "สูง", L: "ต่ำ", N: "ไม่มี" },
  I: { H: "สูง", L: "ต่ำ", N: "ไม่มี" },
  A: { H: "สูง", L: "ต่ำ", N: "ไม่มี" },
};

const RISKY = new Set(["AV:N", "AC:L", "PR:N", "UI:N", "S:C", "C:H", "I:H", "A:H"]);

/**
 * The vector, one chip per metric. A reader who does not know CVSS by heart can
 * see *why* the score is what it is — which is the whole point of printing it.
 */
function cvssChips(vector?: string): string {
  if (!vector) return "";
  const parts = vector.split("/").slice(1).filter((p) => p.includes(":"));
  if (parts.length < 4) return "";
  const chips = parts
    .map((part) => {
      const [key, value] = part.split(":");
      const th = CVSS_TH[key]?.[value] ?? value;
      const cls = value === "N" ? "no" : RISKY.has(`${key}:${value}`) ? "hi" : "";
      return `<div class="met ${cls}"><div class="k">${esc(key)}</div><div class="v">${esc(th)}</div></div>`;
    })
    .join("");
  return `<div class="cvss"><div class="cap">องค์ประกอบคะแนน CVSS v3.0</div>
    <div class="grid">${chips}</div></div>`;
}

function list(items: string[], cls = ""): string {
  const rendered = items.map((item) => richLine(item)).filter(Boolean);
  if (!rendered.length) return "";
  return `<ol class="steps"${cls ? ` style="${cls}"` : ""}>${rendered
    .map((item) => `<li>${item}</li>`)
    .join("")}</ol>`;
}

/** The evidence block keeps its line breaks: a response body is not a paragraph. */
function evidenceBlock(text: string): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return `<div class="ev"><span class="tag">evidence</span>${lines
    .map((line) => `<p>${richLine(line)}</p>`)
    .join("")}</div>`;
}

function findingCard(finding: ClientFinding, index: number): string {
  const style = level(finding);
  const score = Number(finding.cvssScore);
  const hasScore = Number.isFinite(score) && score > 0;
  const discovered = finding.discovered.filter(Boolean);
  const meta: Array<[string, string, boolean]> = [
    ["OWASP", finding.owasp, false],
    ["CWE", finding.cwe || "ไม่ได้บันทึก", false],
    ["WSTG", finding.goal, true],
    ["CVSS v3.0", finding.cvssVector || "ไม่ได้ประเมิน", true],
    ["วันที่พบ", finding.discoveredOn, false],
    ["สถานะ", "ยืนยันแล้ว (Confirmed)", false],
  ];
  if (finding.cve) meta.splice(2, 0, ["CVE", finding.cve, false]);

  return `<article class="finding" style="${sevVars(style)}" data-page-key="${esc(finding.code)}">
  <div class="f-head">
    <div class="f-badge"><span class="n">${String(index + 1).padStart(2, "0")}</span>
      <span class="s">${style.en}</span></div>
    <div class="f-title"><h3>${esc(finding.title)}</h3></div>
    <div class="f-sevbox">
      <span class="score">${hasScore ? score.toFixed(1) : "—"}</span>
      <span class="lbl">${esc(finding.risk)}</span>
      <div class="meter"><i style="width:${hasScore ? Math.min(100, score * 10) : 0}%"></i></div>
    </div>
  </div>

  <div class="f-meta">
    ${meta
      .map(
        ([key, value, wide]) =>
          `<div class="row"${wide ? ' style="grid-column:1 / -1"' : ""}>
        <div class="k">${esc(key)}</div>
        <div class="v${key === "CVSS v3.0" ? " vec" : ""}">${esc(value)}</div></div>`,
      )
      .join("")}
  </div>

  ${cvssChips(finding.cvssVector)}

  ${
    discovered.length
      ? `<section class="f-sec"><h4>สิ่งที่ตรวจพบ</h4>${discovered
          .map((item) => `<p>${inline(item)}</p>`)
          .join("")}</section>`
      : ""
  }

  ${finding.steps.length ? `<section class="f-sec"><h4>ขั้นตอนการทดสอบ</h4>${list(finding.steps)}</section>` : ""}

  ${
    finding.evidence
      ? `<section class="f-sec"><h4>หลักฐานการทดสอบ</h4>${evidenceBlock(finding.evidence)}</section>`
      : ""
  }

  ${
    finding.impactDetails.length
      ? `<section class="f-sec"><h4>ผลกระทบ</h4>${finding.impactDetails
          .map((item) => `<p>${inline(item)}</p>`)
          .join("")}</section>`
      : ""
  }

  ${
    finding.recommendations.length
      ? `<section class="f-sec fix"><h4>แนวทางแก้ไขและคำแนะนำ</h4><div class="box">${finding.recommendations
          .map((item) => `<p>${inline(item)}</p>`)
          .join("")}</div></section>`
      : ""
  }
</article>`;
}

function cover(report: ClientReport, ctx: ReportHtmlContext, findings: ClientFinding[]): string {
  const counts = ctx.stats.bySeverity;
  const chips = SEVERITY_ORDER.map(([th, , key]) => {
    const style = LEVEL[th];
    return `<div class="csev"><i style="background:${style.color}"></i>${th} <b>${
      counts[key as keyof typeof counts] ?? 0
    }</b></div>`;
  }).join("");
  const headline = headlineOf(ctx.target) ?? report.title;
  const subtitle = report.subtitle.includes("—")
    ? report.subtitle.split("—").slice(1).join("—").trim()
    : report.subtitle;

  return `<div class="cover">
  <div class="grid"></div><div class="glow"></div>
  <div class="ring a"></div><div class="ring b"></div>
  <div class="cover-inner">
    <div class="cover-top">
      <div class="brand">VULN<span>PEN</span></div>
    </div>
    <div class="cover-mid">
      <div class="cover-eyebrow">รายงานผลการทดสอบเจาะระบบเว็บแอปพลิเคชัน · Web Application Penetration Test</div>
      <h1>${esc(headline)}</h1>
      <div class="cover-rule"></div>
      <div class="cover-sub">${esc(subtitle || "สรุปช่องโหว่ที่ตรวจพบ")}</div>
      <p class="cover-lede">รายงานฉบับนี้สรุปช่องโหว่ที่ตรวจพบจากการทดสอบเจาะระบบเว็บ จำนวน ${
        findings.length
      } รายการ เรียงลำดับจากความเสี่ยงสูงไปต่ำ แต่ละรายการระบุระดับความเสี่ยง คะแนน CVSS v3.0 สิ่งที่ตรวจพบ ผลกระทบ และแนวทางแก้ไข</p>
      <div class="cover-sevwrap">
        <div class="csev-label">ภาพรวมระดับความเสี่ยง</div>
        <div class="cover-sev">${chips}</div>
      </div>
    </div>
    <div class="cover-meta">
      <div><span>เป้าหมาย</span><strong>${esc(headlineOf(ctx.target) ?? "—")}</strong></div>
      <div><span>ช่วงทดสอบ</span><strong>${esc(ctx.testingWindow || thaiDate(ctx.generatedAt))}</strong></div>
      <div><span>ช่องโหว่ที่พบ</span><strong>${findings.length} รายการ</strong></div>
      <div><span>เวอร์ชัน / วันที่ออก</span><strong>${esc(ctx.version || "1.0")} · ${esc(
        thaiDate(ctx.generatedAt),
      )}</strong></div>
    </div>
    <div class="cover-fine">
      <span>${esc(ctx.tester ? `จัดทำโดย ${ctx.tester}` : "จัดทำโดยทีมทดสอบความปลอดภัย")}</span>
    </div>
  </div>
</div>`;
}

/**
 * A contents line. `key` is the `data-page-key` of the section it points at —
 * the renderer fills `data-toc-key` with the page that section lands on.
 */
function tocRow(key: string, code: string | null, title: string, style?: LevelStyle): string {
  return `<div class="toc-row"${style ? ` style="${sevVars(style)}"` : ""}>
    <div class="t">${code ? `<i class="dot"></i><b>${esc(code.replace(/^F-0*/, ""))}</b>` : '<i class="dot none"></i>'}${esc(title)}</div>
    <div class="p" data-toc-key="${esc(key)}">—</div></div>`;
}

/**
 * The document. Sections carry `data-page-key` so the renderer can number the
 * table of contents from the pagination it is about to produce — Word computes
 * that field itself, HTML has to be told.
 */
export function buildReportHtml(report: ClientReport, ctx: ReportHtmlContext): string {
  const findings = report.body
    .filter((block): block is Extract<typeof block, { type: "finding" }> => block.type === "finding")
    .map((block) => block.finding);
  const summary = report.body.filter((block) => block.type === "p").map((block) => block.text);
  const counts = ctx.stats.bySeverity;
  const critical = counts.critical ?? 0;
  const high = counts.high ?? 0;
  const owasp = owaspSplit(findings);
  const dateLine = `${thaiDate(ctx.generatedAt)} · v${ctx.version || "1.0"}`;

  const phases = [
    {
      window: "ทันที · 0–7 วัน",
      title: "ปิดช่องทางที่ยึดระบบได้",
      items: findings.filter((f) => f.risk === "วิกฤต" || f.risk === "สูง"),
    },
    {
      window: "ระยะกลาง · 8–30 วัน",
      title: "ลดพื้นที่โจมตี",
      items: findings.filter((f) => f.risk === "ปานกลาง"),
    },
    {
      window: "ระยะยาว · 31–90 วัน",
      title: "ป้องกันเชิงกระบวนการ",
      items: findings.filter((f) => f.risk === "ต่ำ" || f.risk === "ข้อมูลข่าวสาร" || f.risk === "ไม่ได้ประเมิน"),
    },
  ];

  const toc = [
    tocRow("summary", null, "บทสรุปผู้บริหาร"),
    ...(ctx.target || ctx.scope
      ? [tocRow("scope", null, "ขอบเขตการทดสอบและเกณฑ์การประเมินความเสี่ยง")]
      : []),
    tocRow("index", null, "ตารางสรุปช่องโหว่ที่ตรวจพบทั้งหมด"),
    '<div class="toc-row grp">รายละเอียดช่องโหว่ · เรียงตามระดับความเสี่ยง</div>',
    ...findings.map((f) => tocRow(f.code, f.code, f.title, level(f))),
    tocRow("roadmap", null, "ภาคผนวก — แผนการแก้ไขตามลำดับความสำคัญ"),
  ].join("");

  const scopeRows: Array<[string, string]> = [];
  if (ctx.target) scopeRows.push(["เป้าหมาย", ctx.target]);
  if (ctx.scope) scopeRows.push(["ขอบเขต", ctx.scope]);
  if (ctx.client) scopeRows.push(["ลูกค้า", ctx.client]);
  if (ctx.tester) scopeRows.push(["ผู้ทดสอบ", ctx.tester]);
  scopeRows.push(["วันที่ทดสอบ", ctx.testingWindow || thaiDate(ctx.generatedAt)]);
  scopeRows.push(["รูปแบบการทดสอบ", ctx.testType || "Web application penetration test"]);
  scopeRows.push(["มาตรฐานอ้างอิง", "OWASP Top 10 : 2025\nOWASP Testing Guide (WSTG)\nCVSS v3.0"]);
  if (ctx.tools?.length) scopeRows.push(["เครื่องมือที่ใช้", ctx.tools.join(", ")]);
  scopeRows.push(["จำนวนช่องโหว่", `${findings.length} รายการ (ยืนยันแล้วทั้งหมด)`]);
  if (ctx.stats.coverage.total > 0) {
    scopeRows.push([
      "ความครอบคลุม WSTG",
      `ดำเนินการ ${ctx.stats.coverage.executed}/${ctx.stats.coverage.total} (${ctx.stats.coverage.percentExecuted}%)`,
    ]);
  }

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>${esc(report.title)} — ${esc(headlineOf(ctx.target) ?? report.subtitle)}</title>
<style>${fontFaces()}${CSS}</style></head><body>

${cover(report, ctx, findings)}

<section class="pagebreak" data-page-key="toc">
  <div class="sec-head">
    <div><div class="kicker">Contents</div><h2>สารบัญ</h2></div>
    <div class="no">${esc(dateLine)}</div>
  </div>
  <div class="toc">${toc}</div>
  <div class="toc-legend">
    <span class="tl">ระดับความเสี่ยง</span>
    ${SEVERITY_ORDER.slice(0, 4)
      .map(([th, , key]) => {
        const style = LEVEL[th];
        return `<span class="tlc" style="${sevVars(style)}"><i></i>${th} ${
          counts[key as keyof typeof counts] ?? 0
        }</span>`;
      })
      .join("")}
    <span class="tln">รวม ${findings.length} รายการ</span>
  </div>
</section>

<section class="pagebreak" data-page-key="summary">
  <div class="sec-head">
    <div><div class="kicker">01 · Executive Summary</div><h2>บทสรุปผู้บริหาร</h2></div>
    <div class="no">${esc(dateLine)}</div>
  </div>

  <p class="lede">การทดสอบเจาะระบบเว็บแอปพลิเคชัน${ctx.target ? `ที่ <strong>${esc(
    headlineOf(ctx.target) ?? ctx.target,
  )}</strong>` : ""} พบช่องโหว่ที่ยืนยันแล้วทั้งหมด <strong>${findings.length} รายการ</strong>
  แบ่งเป็นระดับวิกฤต ${critical} รายการ ระดับสูง ${high} รายการ ระดับปานกลาง ${
    counts.medium ?? 0
  } รายการ และระดับต่ำ ${counts.low ?? 0} รายการ</p>

  ${
    critical + high > 0
      ? `<div class="callout"><div class="ck">ข้อสรุปที่สำคัญ</div>
    <div class="ct">พบช่องโหว่ระดับวิกฤต ${critical} รายการ และระดับสูง ${high} รายการ
    ซึ่งควรแก้ไขให้เสร็จก่อนเปิดให้ระบบใช้งานจริง${critical > 0 ? " และควรจำกัดการเข้าถึงระบบจากเครือข่ายภายนอกระหว่างดำเนินการแก้ไข" : ""}</div></div>`
      : ""
  }

  ${statTiles(ctx.stats)}

  ${
    summary.length
      ? summary.map((paragraph) => `<p>${inline(paragraph)}</p>`).join("")
      : ""
  }

  <div class="hr"></div>

  <div class="two-col">
    <div>
      <h4 style="font-size:15pt;color:var(--navy);margin-bottom:3mm">การกระจายตามระดับความเสี่ยง</h4>
      ${severityBars(ctx.stats)}
    </div>
    <div>
      <h4 style="font-size:15pt;color:var(--navy);margin-bottom:3mm">หมวดหมู่ตาม OWASP Top 10 : 2025</h4>
      <div class="owasp-grid">${owasp
        .map(
          (entry) =>
            `<div class="or"><span class="ol"><b>${esc(entry.id)}</b>${esc(entry.label)}</span><span class="on">${entry.n}</span></div>`,
        )
        .join("")}</div>
    </div>
  </div>
</section>

${
  ctx.target || ctx.scope
    ? `<section class="pagebreak" data-page-key="scope">
  <div class="sec-head">
    <div><div class="kicker">02 · Scope &amp; Method</div><h2>ขอบเขตการทดสอบและเกณฑ์การประเมินความเสี่ยง</h2></div>
    <div class="no">${esc(dateLine)}</div>
  </div>

  <div class="two-col">
    <div>
      <h4 style="font-size:14.5pt;color:var(--navy);margin-bottom:2mm">ข้อมูลการทดสอบ</h4>
      <table class="kv">
        ${scopeRows
          .map(
            ([key, value]) =>
              `<tr><td>${esc(key)}</td><td>${String(value)
                .split("\n")
                .map((line) => inline(line))
                .join("<br>")}</td></tr>`,
          )
          .join("")}
      </table>
    </div>
    <div>
      <h4 style="font-size:14.5pt;color:var(--navy);margin-bottom:2mm">เกณฑ์การประเมินระดับความเสี่ยง</h4>
      <table class="tbl risk">
        <thead><tr><th style="width:22mm">ระดับ</th><th style="width:21mm">ช่วงคะแนน</th><th>ความหมาย</th></tr></thead>
        <tbody>
          ${[
            ["วิกฤต", "9.0 – 10.0", "ยึดระบบได้ทันที ต้องแก้ไขก่อนใช้งาน"],
            ["สูง", "7.0 – 8.9", "กระทบข้อมูลสำคัญ แก้ไขเร่งด่วน"],
            ["ปานกลาง", "4.0 – 6.9", "ต้องอาศัยเงื่อนไขประกอบ ควรแก้ไขตามรอบ"],
            ["ต่ำ", "0.1 – 3.9", "ความเสี่ยงจำกัด ปรับปรุงเชิงป้องกัน"],
            ["ข้อมูลข่าวสาร", "0.0", "ข้อสังเกต ไม่ใช่ช่องโหว่โดยตรง"],
          ]
            .map(([th, range, meaning]) => {
              const style = LEVEL[th];
              return `<tr style="${sevVars(style)}"><td><span class="chip"><i></i>${th}</span></td>
                <td>${range}</td><td>${meaning}</td></tr>`;
            })
            .join("")}
        </tbody>
      </table>

      <h4 style="font-size:14.5pt;color:var(--navy);margin:6mm 0 2mm">ระเบียบวิธี</h4>
      <ol class="steps" style="--sev:${LEVEL["ปานกลาง"].color}">
        <li>สำรวจและระบุบริการที่เปิดให้เข้าถึง (reconnaissance / service enumeration)</li>
        <li>ตรวจหาช่องโหว่ตามหมวด OWASP WSTG และยืนยันด้วยหลักฐานจริงทุกกรณี</li>
        <li>ประเมินผลกระทบและให้คะแนนตาม CVSS v3.0 พร้อมเวกเตอร์ประกอบ</li>
        <li>จัดลำดับความเสี่ยงและเสนอแนวทางแก้ไขที่ปฏิบัติได้จริง</li>
      </ol>
    </div>
  </div>

  <div class="panel" style="margin-top:5mm">
    <h4>ข้อจำกัดของรายงาน</h4>
    <p style="margin:0;font-size:13.2pt;color:var(--ink2)">${
      ctx.limitations
        ? inline(ctx.limitations)
        : "การทดสอบจำกัดอยู่ที่ขอบเขตที่ระบุไว้ข้างต้น และดำเนินการในสภาพแวดล้อมทดสอบ ผลการทดสอบสะท้อนสถานะของระบบ ณ วันที่ทดสอบเท่านั้น การเปลี่ยนแปลงการตั้งค่าหรือการติดตั้งซอฟต์แวร์เพิ่มเติมอาจทำให้ผลลัพธ์เปลี่ยนไป"
    }</p>
  </div>
</section>`
    : ""
}

<section class="pagebreak" data-page-key="index">
  <div class="sec-head">
    <div><div class="kicker">03 · Findings Index</div><h2>ตารางสรุปช่องโหว่ที่ตรวจพบทั้งหมด</h2></div>
    <div class="no">${esc(dateLine)}</div>
  </div>
  <table class="tbl">
    <thead><tr><th style="width:9mm">#</th><th>ช่องโหว่</th><th style="width:24mm">ระดับ</th>
      <th style="width:14mm;text-align:right">CVSS</th><th style="width:26mm">CWE</th></tr></thead>
    <tbody>
    ${findings
      .map((finding, index) => {
        const style = level(finding);
        const score = Number(finding.cvssScore);
        return `<tr style="${sevVars(style)}">
      <td class="num">${String(index + 1).padStart(2, "0")}</td>
      <td>${esc(finding.title)}<div class="id">${esc(finding.owasp)} · ${esc(
        finding.goal.split(" ")[0],
      )}</div></td>
      <td><span class="chip"><i></i>${esc(finding.risk)}</span></td>
      <td class="cv">${Number.isFinite(score) && score > 0 ? score.toFixed(1) : "—"}</td>
      <td class="id" style="font-family:Consolas,monospace">${esc(
        (finding.cwe || "—").split(" ")[0],
      )}</td>
    </tr>`;
      })
      .join("")}
    </tbody>
  </table>
  ${
    findings.length
      ? ""
      : '<p style="margin-top:6mm">ไม่พบช่องโหว่ที่ต้องรายงานจากการทดสอบในขอบเขตที่กำหนด</p>'
  }
</section>

${findings.map((finding, index) => findingCard(finding, index)).join("\n")}

<section class="pagebreak" data-page-key="roadmap">
  <div class="sec-head">
    <div><div class="kicker">04 · Appendix</div><h2>ภาคผนวก — แผนการแก้ไขตามลำดับความสำคัญ</h2></div>
    <div class="no">${esc(dateLine)}</div>
  </div>
  <p class="note" style="margin-bottom:4mm">ลำดับการแก้ไขด้านล่างจัดกลุ่มตามระดับความเสี่ยงที่รายงานไว้ข้างต้น
  รายการในกลุ่มแรกควรดำเนินการให้เสร็จก่อนเปิดให้ใช้งานระบบอีกครั้ง</p>

  <div class="road">
    ${phases
      .map(
        (phase) => `<div class="col">
      <div class="hd"><div class="w">${phase.window}</div><div class="t">${phase.title}</div></div>
      <div class="bd">${
        phase.items.length
          ? `<ul>${phase.items
              .map(
                (item) =>
                  `<li><b>${esc(item.code.replace(/^F-0*/, ""))}</b><span class="cl">${esc(
                    item.title,
                  )}</span></li>`,
              )
              .join("")}</ul>`
          : '<div class="empty">ไม่มีรายการในกลุ่มนี้</div>'
      }</div>
    </div>`,
      )
      .join("")}
  </div>

  <div class="panel" style="margin-top:7mm">
    <h4>ข้อเสนอแนะในการดำเนินการต่อ</h4>
    <p style="margin:0;font-size:14.2pt;line-height:1.35">รายการระดับวิกฤตและระดับสูงควรแก้ไขให้เสร็จก่อนเปิดให้บริการ
    ส่วนรายการระดับปานกลางและต่ำสามารถจัดเป็นรอบการปรับปรุงตามปกติ หลังแก้ไขครบแล้วควรทดสอบซ้ำ (retest)
    เฉพาะรายการที่แก้ไขเพื่อยืนยันว่าปิดช่องโหว่ได้จริง และควรทบทวนการตั้งค่าเซิร์ฟเวอร์ตาม hardening checklist
    ก่อนนำระบบขึ้นใช้งานทุกครั้ง</p>
  </div>

  <div class="footer-note">
    จัดทำโดย${esc(ctx.tester || "ทีมทดสอบความปลอดภัย")} · ${esc(thaiDate(ctx.generatedAt))}
  </div>
</section>

</body></html>`;
}
