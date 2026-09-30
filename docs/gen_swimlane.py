# -*- coding: utf-8 -*-
"""Generate docs/SWIMLANE.svg — swimlane diagram of the VulnPen system."""
import html

W, H = 1300, 900
LANE_X = 150          # x where phase columns start
TOP = 96              # y after phase chevrons
COL_W = (W - LANE_X - 20) // 5   # 5 phase columns

LANES = [
    ("USER / HTML",            "#ffe3e3", "#d64545", 92),
    ("ORCHESTRATOR / AI",      "#e3ecff", "#3b5bd6", 104),
    ("WSTG SPECIALISTS",       "#e2f6e6", "#2e8b46", 96),
    ("WORKERS → KALI (SSH)",   "#fff1d6", "#c07f16", 100),
    ("BURP + BROWSER AGENT",   "#f0e3ff", "#7a2fd6", 118),
    ("DATA (MONGO / REDIS)",   "#dff2f5", "#1a7f8c", 78),
]

lane_y = {}
y = TOP
for i, (name, fill, stroke, h) in enumerate(LANES):
    lane_y[name] = (y, h)
    y += h + 8

PHASES = [
    ("1. INITIATE & SETUP", "#dbeafe", "#2563eb"),
    ("2. RECON",            "#dcfce7", "#16a34a"),
    ("3. WSTG TEST PLAN",   "#fef9c3", "#ca8a04"),
    ("4. EXECUTE & EVIDENCE", "#ffedd5", "#ea580c"),
    ("5. MAP & REPORT",     "#fae8ff", "#a21caf"),
]

# node: (lane, col, text lines, fill, stroke)
NODES = [
    # Phase 1 — initiate
    (0, 0, ["สร้าง Workspace / Session", "(เลือก Pentest WSTG)"], "#ffffff", "#d64545"),
    (1, 0, ["อ่าน env + สร้าง System Prompt", "(WSTG v4.2 + capabilities)"], "#ffffff", "#3b5bd6"),
    (5, 0, ["persist session", "(MongoDB)"], "#ffffff", "#1a7f8c"),
    # Phase 2 — recon
    (0, 1, ["สั่งงานในแชต", "/wstg <target>"], "#ffffff", "#d64545"),
    (1, 1, ["วางแผน Recon + spawn tools"], "#ffffff", "#3b5bd6"),
    (3, 1, ["run_bash → SSH :4242", "nmap / ffuf / whatweb"], "#ffffff", "#c07f16"),
    # Phase 3 — plan
    (1, 2, ["wstg_test_plan generate", "(catalogue 97 / custom)"], "#fff8dc", "#ca8a04"),
    (0, 2, ["แก้ไข / เพิ่ม case", "(ปุ่ม Edit / Add custom)"], "#ffffff", "#d64545"),
    (5, 2, ["save test plan", "(cases + status)"], "#ffffff", "#1a7f8c"),
    # Phase 4 — execute
    (1, 3, ["spawn subagent รายหมวด", "(INPV / ATHN / SESS ...)"], "#ffffff", "#3b5bd6"),
    (2, 3, ["รัน test case ตามแผน", "update_case + observations"], "#ffffff", "#2e8b46"),
    (0, 3, ["ยืนยัน consent", "(requires_consent)"], "#ffffff", "#d64545"),
    (3, 3, ["รัน tools + เก็บ evidence", "(ไฟล์ใน workspace)"], "#ffffff", "#c07f16"),
    (4, 3, ["browser_action → Chromium", "ผ่าน Burp proxy (intercept HTTPS)"], "#ffffff", "#7a2fd6"),
    (4, 3, None, None, None),  # placeholder replaced below
    # Phase 5 — map & report
    (1, 4, ["auto-map OWASP (ถ้าตรงจริง)", "สร้าง Report Draft (/report)"], "#ffffff", "#3b5bd6"),
    (5, 4, ["save vulnerabilities", "+ owasp/cwe/cvss (optional)"], "#ffffff", "#1a7f8c"),
    (0, 4, ["ดูหน้า Vulnerabilities", "ตรวจ Report + Export"], "#ffffff", "#d64545"),
]

# Burp-specific second node in lane 4 phase 4
BURP2 = (4, 3, ["Burp: history / Intruder", "ผ่าน gRPC :50051"], "#ffffff", "#7a2fd6")

# fix duplicate placeholder: rebuild list
NODES = [n for n in NODES if n[2] is not None] + [BURP2]

# edges: (from lane,col, to lane,col, label, dashed)
EDGES = [
    ((0, 0), (1, 0), ""),
    ((1, 0), (5, 0), ""),
    ((0, 1), (1, 1), ""),
    ((1, 1), (3, 1), "SSH"),
    ((1, 1), (1, 2), ""),
    ((1, 2), (0, 2), "แก้ได้"),
    ((1, 2), (5, 2), ""),
    ((1, 2), (1, 3), "เริ่ม execute"),
    ((1, 3), (2, 3), "spawn"),
    ((2, 3), (3, 3), "run tools"),
    ((1, 3), (4, 3), "browser agent"),
    ((4, 3), (3, 3), "proxy", True),
    ((2, 3), (1, 4), "findings"),
    ((4, 3), (1, 4), "history", True),
    ((1, 4), (5, 4), ""),
    ((1, 4), (0, 4), "report"),
]

svg = []
svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}" font-family="Segoe UI, Tahoma, sans-serif">')
svg.append(f'<rect width="{W}" height="{H}" fill="#f6f7fb"/>')
svg.append('<defs>'
           '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
           '<path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker>'
           '</defs>')
svg.append(f'<text x="{W/2}" y="26" text-anchor="middle" font-size="19" font-weight="700" fill="#222">'
           'VulnPen — OWASP WSTG v4.2 Web Pentest Flow (Swim Lane)</text>')

# phase chevrons
for i, (label, fill, stroke) in enumerate(PHASES):
    x = LANE_X + i * COL_W + 6
    wch = COL_W - 14
    p = 14
    pts = f"{x},{TOP-58} {x+wch-p},{TOP-58} {x+wch},{TOP-38} {x+wch-p},{TOP-18} {x},{TOP-18} {x+p},{TOP-38}"
    svg.append(f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    svg.append(f'<text x="{x+wch/2}" y="{TOP-33}" text-anchor="middle" font-size="12.5" '
               f'font-weight="700" fill="{stroke}">{html.escape(label)}</text>')

# lane bands + labels
for i, (name, fill, stroke, h) in enumerate(LANES):
    ly, _ = lane_y[name]
    svg.append(f'<rect x="{LANE_X}" y="{ly}" width="{W-LANE_X-10}" height="{h}" '
               f'fill="{fill}" opacity="0.35" stroke="{stroke}" stroke-width="0.7" stroke-dasharray="4 3"/>')
    svg.append(f'<rect x="8" y="{ly}" width="{LANE_X-18}" height="{h}" rx="8" '
               f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    lines = name.split(" / ")
    ty = ly + h/2 - (len(lines)-1)*8
    for j, ln in enumerate(lines):
        svg.append(f'<text x="{8+(LANE_X-18)/2}" y="{ty+j*16+5}" text-anchor="middle" '
                   f'font-size="12" font-weight="700" fill="{stroke}">{html.escape(ln)}</text>')

def node_center(lane, col):
    ly, lh = lane_y[LANES[lane][0]]
    return LANE_X + col*COL_W + COL_W//2, ly + lh/2

def draw_node(lane, col, lines, fill, stroke, w=190):
    ly, lh = lane_y[LANES[lane][0]]
    x = LANE_X + col*COL_W + (COL_W-w)//2
    nh = 16 + len(lines)*15
    y = ly + (lh-nh)//2
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{nh}" rx="9" '
               f'fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
    for j, ln in enumerate(lines):
        svg.append(f'<text x="{x+w/2}" y="{y+21+j*15}" text-anchor="middle" '
                   f'font-size="10.8" fill="#222">{html.escape(ln)}</text>')
    return (x + w/2, y + nh/2, x, y, w, nh)

pos = {}
for lane, col, lines, fill, stroke in NODES:
    key = (lane, col)
    if key in pos:   # second node in same cell — stack lower half
        cx, cy, bx, by, bw, bh = pos[key]
        ly, lh = lane_y[LANES[lane][0]]
        x = LANE_X + col*COL_W + (COL_W-170)//2
        nh = 16 + len(lines)*15
        y = ly + lh - nh - 8
        svg.append(f'<rect x="{x}" y="{y}" width="170" height="{nh}" rx="9" '
                   f'fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
        for j, ln in enumerate(lines):
            svg.append(f'<text x="{x+85}" y="{y+21+j*15}" text-anchor="middle" '
                       f'font-size="10.8" fill="#222">{html.escape(ln)}</text>')
        pos[(lane, col, "b")] = (x+85, y+nh/2, x, y, 170, nh)
        continue
    pos[key] = draw_node(lane, col, lines, fill, stroke)

# edges
for (la, ca), (lb, cb), label, *rest in EDGES:
    dashed = rest[0] if rest else False
    if (la, ca, "b") in pos and la == 4 and ca == 3 and (lb, cb) == (3, 3):
        fx, fy, _, _, _, _ = pos[(la, ca, "b")]
    else:
        fx, fy, _, _, _, _ = pos[(la, ca)]
    tx, ty, _, _, _, _ = pos[(lb, cb)]
    dashed_attr = 'stroke-dasharray="5 4"' if dashed else ''
    svg.append(f'<line x1="{fx}" y1="{fy}" x2="{tx}" y2="{ty}" stroke="#555" '
               f'stroke-width="1.4" {dashed_attr} marker-end="url(#arr)"/>')
    if label:
        mx, my = (fx+tx)/2, (fy+ty)/2
        svg.append(f'<rect x="{mx-38}" y="{my-9}" width="76" height="14" rx="4" fill="#ffffffcc"/>')
        svg.append(f'<text x="{mx}" y="{my+2}" text-anchor="middle" font-size="9" fill="#444">{html.escape(label)}</text>')

svg.append('</svg>')

with open("docs/SWIMLANE.svg", "w", encoding="utf-8") as f:
    f.write("\n".join(svg))
print("written docs/SWIMLANE.svg")
