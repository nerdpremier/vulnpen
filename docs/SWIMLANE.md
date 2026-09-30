# VulnPen — System Swim Lane Diagram

แผนภาพแบบ Swim Lane ของระบบ โดยแต่ละ lane คือผู้เล่น/ส่วนประกอบหลัก
(render ด้วย Mermaid — วางใน GitHub / VS Code / mermaid.live ได้เลย)

```mermaid
flowchart TB
    subgraph L1["👤 User / Browser"]
        U1["เว็บ UI (Next.js :3000)<br/>แชต, Test Plan, Vulnerabilities,<br/>GUI tab, Burp tab, Settings"]
        U2["noVNC client (iframe)<br/>ดูจอ Browser Agent + GUI"]
    end

    subgraph L2["⚙️ Backend API (Node :8080, Docker)"]
        B1["REST API + SSE stream<br/>(auth, sessions, workspaces,<br/>settings, test-plan, vulns)"]
        B2["AI Orchestrator + Subagents<br/>(system prompt = WSTG v4.2)"]
        B3["Tool executors<br/>run_bash / run_python / install_tool"]
        B4["Engagement State<br/>(add_vulnerability, key discovery)"]
        B5["Browser Agent (Magnitude)<br/>launchOptions: proxy=Burp"]
    end

    subgraph L3["🖥️ Work Host — Kali container"]
        K1["SSH server (:4242)"]
        K2["Pentest tools<br/>nmap, sqlmap, ffuf, hydra ..."]
        K3["Burp Suite Community<br/>proxy :8080 (all interfaces)"]
        K4["burp-rpc extension<br/>gRPC :50051"]
        K5["Xvnc :89 (rfb 5989)<br/>+ XFCE desktop"]
        K6["websockify/noVNC (:9020)"]
    end

    subgraph L4["🌐 Browser Agent stack (ใน backend container)"]
        A1["Xvfb :99 (1280x800)"]
        A2["x11vnc (rfb 5999)"]
        A3["websockify/noVNC (:6080)"]
        A4["Chromium (Patchright)<br/>--proxy-server=kali:8080<br/>trust Burp CA (NSS)"]
    end

    subgraph L5["🗄️ Data"]
        D1[("MongoDB :27017<br/>users, workspaces, sessions,<br/>test plan, vulnerabilities")]
        D2[("Redis :6379")]
    end

    %% UI ↔ Backend
    U1 -->|"HTTP + session cookie"| B1
    B1 <-->|"SSE (แชต/tool stream)"| U1
    U2 -->|"/vnc.html + WebSocket"| A3
    U2 -->|"/vnc.html + WebSocket (localhost:9020)"| K6

    %% Backend internals
    B1 --> B2
    B2 -->|"เรียก tools"| B3
    B2 -->|"บันทึกผล"| B4
    B1 --> B5
    B5 --> A4

    %% Backend → Kali
    B3 -->|"exec คำสั่งผ่าน SSH"| K1
    K1 --> K2
    B1 -->|"gRPC ping/history/intruder<br/>(host=kali)"| K4
    K4 -.->|"ควบคุม"| K3

    %% Browser agent traffic
    A4 -->|"HTTP/HTTPS traffic<br/>(interception)"| K3

    %% VNC stacks
    A1 --> A2 --> A3
    K5 --> K6

    %% Persistence
    B1 --> D1
    B1 --> D2
```

## อ่านไหล่ยังไง (เส้นทางสำคัญ)

| เส้นทาง | อธิบาย |
|---|---|
| User → Backend → SSE → User | แชตกับ AI, tool call stream, ตาราง Test Plan / Vulnerabilities ทั้งหมดผ่าน REST + SSE ที่ :8080 |
| Backend → SSH → Kali | AI สั่ง `run_bash` → backend SSH เข้า kali (work host) รัน nmap/sqlmap ฯลฯ headless |
| Browser Agent lane | สั่ง agent → Magnitude launch Chromium บน Xvfb :99 → traffic วิ่งผ่าน Burp proxy (kali:8080) เพื่อ interception → ภาพจอส่งผ่าน x11vnc → noVNC :6080 → iframe ใน panel ขวา |
| GUI lane (ผู้ใช้ใช้เอง) | Xvnc :89 + XFCE บน kali → websockify :9020 → แท็บ GUI; Burp รันบน desktop นี้ด้วย |
| Burp RPC | backend เรียก gRPC :50051 เพื่ออ่าน Proxy History / ส่ง Intruder / ส่ง Repeater |
| Data | Mongo เก็บทุกอย่าง (session/plan/vuln), Redis เป็น queue/cache |
