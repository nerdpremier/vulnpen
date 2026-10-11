# Browser Agent — วินิจฉัยสาเหตุ แนวทางแก้ไข และการประเมิน jev-ultrafast

เอกสารนี้ตอบสามคำถามจากรายงานปัญหา:

1. ทำไม browser agent ถึงค้าง / ใช้งานไม่ได้ และทำไม AI ถึง "ติดขัด–เอ๋อ" เมื่อเปิดใช้
2. ทำไมระบบยังต้องใช้ screenshot ทั้งที่โมเดลอ่านรูปภาพได้โดยตรง
3. ควรเอา `browser-use/jev-ultrafast` มาใช้แทนหรือปรับปรุงหรือไม่

---

## 1. สรุปสำหรับผู้บริหาร

อาการ "เบราว์เซอร์ค้าง" และ "AI เอ๋อ" **ไม่ใช่สาเหตุเดียวกัน** แต่ต่อกันเป็นลูกโซ่:

```
สาเหตุที่ 1  เบราว์เซอร์เข้าถึงเป้าหมายไม่ได้ (อยู่ผิดที่หลัง agent ย้ายไป attack box)
        ↓  ทุก navigation จึงรอจนหมดเวลา
สาเหตุที่ 2  run ที่ค้าง 1 ครั้ง ล็อกทั้ง chain ไว้ตลอดไป   ← ตัวทำให้ "ค้างถาวร"
        ↓  browser_action ทุกครั้งหลังจากนั้น timeout ที่ 120 วิ
สาเหตุที่ 3  AI เห็นแต่ error/timeout จึงลองซ้ำ → ดูเหมือน "เอ๋อ"
        ↓  ทุกครั้งที่ลองซ้ำ ได้ snapshot ยาว 4–10k ตัวอักษรกลับไปด้วย
สาเหตุที่ 4  context บวมเร็ว → ถูก summarize กลางงาน → ตาราง element หาย → วนซ้ำ
```

ตัวที่รุนแรงที่สุดคือ **ข้อ 2**: เป็นบั๊กเชิงโครงสร้างในโค้ด ไม่ใช่ปัญหาเครือข่ายหรือการตั้งค่า
และเป็นตัวเดียวที่ทำให้ "เปิดใช้แล้วพังทั้งระบบจนกว่าจะรีสตาร์ต backend"

**แก้แล้วทั้ง 5 ข้อ** — 4 ข้อแรกดูหัวข้อ 3 ส่วนข้อ 1 (สาเหตุเชิงสถาปัตยกรรม) แก้ด้วยการย้าย
เบราว์เซอร์ไป attack box ดูหัวข้อ 4

**สถานะปัจจุบัน: แก้เสร็จ + deploy แล้ว** — อิมเมจ `projectz-backend` ถูก build ใหม่, คอนเทนเนอร์
`vulnpen-backend` เป็น healthy, และ `browser-dom-check.ts` ที่รันจากในอิมเมจได้ `PASS 15/15`
โดยไม่ใช้ vision และไม่ใช้ screenshot (ดูหัวข้อ 9)

---

## 2. สาเหตุที่พบ เรียงตามความรุนแรง

### 2.1 [P0 · บั๊กเชิงโครงสร้าง] run ที่ค้าง 1 ครั้ง ล็อก chain ถาวร

`browser-agent.service.ts` ใช้ agent ตัวเดียวร่วมกันทั้ง process และ serialize การใช้งานผ่าน promise chain:

```ts
export function runBrowserAgentExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = runChain.then(fn, fn);
  runChain = run.then(() => undefined, () => undefined);   // ← ผูกกับ run ตรง ๆ
  return run;
}
```

ในขณะเดียวกันชั้น tool มีเพดานเวลาของตัวเองด้วย `Promise.race` (`agent.tools.ts:37–52`):

```ts
return await Promise.race([
  toolDef.execute(args, ctx),
  new Promise((_, reject) => { timer = setTimeout(() => reject(...), timeoutMs); }),
]);
```

`Promise.race` **ไม่ยกเลิกงานที่แพ้การแข่ง** — เมื่อครบ 120 วิ (`magnitude-browser.ts:180`)
ชั้น tool คืน error กลับไปให้โมเดล แต่ promise ของ `fn` ยังทำงานอยู่เบื้องหลังและยังไม่ settle
ผลคือ `runChain` ยังคงค้างอยู่ที่ promise นั้น **ตลอดไป**

นับจากวินาทีนั้น `browser_action` ทุกครั้งจะถูกต่อท้าย promise ที่ไม่มีวัน resolve →
ทุกครั้งจะ timeout ที่ 120 วิ → คืนข้อความ timeout เหมือนกันหมด → โมเดลลองซ้ำ →
ผู้ใช้เห็น "เบราว์เซอร์ค้าง ใช้งานไม่ได้" และ "AI เอ๋อ" พร้อมกัน
และจะหายเฉพาะเมื่อรีสตาร์ต backend เท่านั้น

> นี่คือคำตอบหลักของอาการที่รายงาน และเป็นข้อที่แก้ไปแล้ว (หัวข้อ 3.1)

### 2.2 [P0 · สถาปัตยกรรม] เบราว์เซอร์รัน "ข้าง backend" แต่เป้าหมายอยู่หลัง attack box

commit `c9c4fbf` ("the agent runs on the attack box over SSH and never inside the backend")
ย้ายการทำงานทั้งหมดไป attack box และ **ถอด `NET_ADMIN` ออกจาก backend**:

```
docker-compose.yml          - cap_add: [NET_ADMIN]
docker-compose.kali.yml     - cap_add: [NET_ADMIN]
```

แต่ browser agent ยังคงเปิด Chromium **ใน process ของ backend** (`browser-agent.service.ts`,
`buildBrowserAgentConfig` → `launchOptions` พร้อม `HOME: getBurpBrowserHome()`)

ผลที่ตามมา: ถ้าเป้าหมายเข้าถึงได้เฉพาะผ่าน VPN ที่ต่ออยู่บน attack box เบราว์เซอร์ใน backend
จะไม่มีเส้นทางไปถึงเลย — ซึ่งเป็นความเสี่ยงที่ทีมบันทึกไว้เองแล้วในตารางความเสี่ยง
`docs/SETUP.md:21`:

> | P0 | Browser target is only reachable through the SSH host's VPN | … | Connect the VPN on the
> attack box and expose an HTTP/SOCKS proxy reachable by the backend, **or use the attack box's
> own tools instead of the Browser Agent.** |

คือ ณ สถาปัตยกรรมปัจจุบัน ทางแก้ที่ทีมเขียนไว้เองคือ "อย่าใช้ browser agent"
นี่คือเหตุผลที่การย้ายไป attack box แล้ว browser agent "ใช้งานไม่ได้" ทั้งที่โค้ดไม่ได้ถูกแก้ให้เสีย

ซ้ำร้าย เมื่อตั้ง `MAGNITUDE_PROXY_URL` ไว้แต่ proxy นั้นยิงไม่ถึง Chromium จะค้างทุก request
ซึ่งกลายเป็นสาเหตุที่ทำให้เกิดข้อ 2.1 ต่อทันที (ค้าง → chain ตาย)

### 2.3 [P1] กด element ที่ตัวเองเพิ่งอ่านจาก snapshot ไม่เจอ

`dom-browser.service.ts` สร้างชื่อ element จาก label / aria-label / placeholder / `value` /
`textContent` แล้วตอนกดจะประกอบ locator กลับเป็น:

```ts
page.getByRole(el.role as any, { name: el.name, exact: true })
```

สองปัญหาที่ทำให้ "โมเดลอ่านเจอ แต่กดไม่ติด":

- **role ไม่ใช่ ARIA role** — `roleOf()` fallback ไปใช้ชื่อ tag สำหรับ element ที่ไม่มี role
  (`<div tabindex>` → `"div"`, `<label>` → `"label"`) และ `page.getByRole("div")` **โยน error**
  ทันที ไม่ใช่ timeout
- **ชื่อไม่ตรง accessible name ที่ Playwright คำนวณเอง** — เช่น input ที่ได้ชื่อมาจาก placeholder
  หรือปุ่มที่ได้ชื่อมาจาก `value` การบังคับ `exact: true` จึงไม่ match

ผลคือโมเดลต้องเดาใหม่ วนอ่าน snapshot ซ้ำ ซึ่งกินทั้งเวลาและ context

### 2.4 [P1] context บวม จนถูก summarize กลางงาน

เดิมทุก action ที่ไม่ใช่ `snapshot` จะคืนกลับ 4 ส่วนพร้อมกัน:

```
<ผลของ action>
Page: … / URL: …
Interactive elements (N): <ตาราง 120 บรรทัด>     ← ส่งซ้ำทุกครั้ง
Visible text: <สูงสุด 3,000 ตัวอักษร>
```

รวมแล้วประมาณ 4,000–10,000 ตัวอักษรต่อ 1 action ถ้า flow หนึ่งใช้ 15–20 action
จะกิน context 60,000–200,000 ตัวอักษร ซึ่งชนเพดาน `workingSetBudget`
(`compaction.service.ts`) และ trigger การ summarize กลาง flow
เมื่อ transcript ถูกย่อ ตาราง element ที่โมเดลกำลังถืออยู่จะหายไป
โมเดลจึงต้อง snapshot ใหม่ → context โตอีก → summarize อีก วนซ้ำ
นี่คือลักษณะ "เอ๋อ" ที่สังเกตได้ (ทำซ้ำขั้นตอนเดิม พูดวน และลืมสิ่งที่เพิ่งทำ)

### 2.5 [P2] สั่ง action ที่ element ทำไม่ได้ → เสียเวลาเต็ม timeout

snapshot บอกอยู่แล้วว่า element แต่ละตัวรองรับอะไร (`ops`) แต่ตอนรันไม่ได้ตรวจ
การ `fill` ใส่ปุ่ม หรือ `select` ใส่ input จึงไปรอ locator timeout 15 วิ ก่อนจะ error

### 2.6 [P0 · เจอจากการรันจริง] DOM path ตายทันทีเมื่อรันด้วย tsx: `ReferenceError: __name is not defined`

รัน `scripts/browser-dom-check.ts` ในคอนเทนเนอร์จริงแล้วได้:

```
DOM browser check failed: page.evaluate: ReferenceError: __name is not defined
    at collectElements (dom-browser.service.ts)
```

สาเหตุ: tsx ใช้ esbuild ที่ตั้ง `keepNames: true` ทำให้ฟังก์ชันที่มีชื่อทุกตัวถูกห่อด้วย
`__name(fn, "fn")` แต่ `page.evaluate()` **ส่งซอร์สของฟังก์ชันไปรันในหน้าเว็บ** ซึ่งไม่มี helper ตัวนั้น
→ `collectElements` ล้มก่อนอ่าน element ตัวแรกด้วยซ้ำ

ผลที่ตามมาร้ายแรงกว่าตัว error: **การอ่านหน้าเป็น DOM ไม่เคยทำงานจริงเลยแม้แต่ครั้งเดียว**
ในเส้นทางที่รันด้วย tsx (สคริปต์ตรวจสอบทั้งหมด และเทสต์) — สคริปต์ที่เขียนขึ้นเพื่อพิสูจน์ว่า
"ไม่มี vision, ใช้ DOM ได้" จึงไม่เคยผ่าน ทำให้บั๊กในข้อ 2.7 ถูกซ่อนอยู่ข้างหลัง
(เส้นทาง production รัน `node dist/server.js` ซึ่ง tsc ไม่ inject helper จึงไม่เจอ — ตรวจแล้วว่า
dist ไม่มีคำว่า `__name` เลย)

### 2.7 [P1 · เจอจากการรันจริง] ตาราง element มีป้าย `<label>` ซ้ำกับช่องกรอกของมัน

หลังแก้ 2.6 ตารางที่โมเดลเห็นคือ:

```
[1] label      Username — click        ← ซ้ำกับ [2]
[2] textbox    Username — fill
[3] label      Password — click        ← ซ้ำกับ [4]
[4] textbox    Password — fill
[7] checkbox   Accept terms = "on" — check/fill   ← checkbox ไม่ควรมี fill
```

โมเดลถือ **สอง id สำหรับหนึ่งช่อง** และมีโอกาสเลือกแถวผิด (เลือก label แล้วสั่ง `fill` ซึ่งถูกปฏิเสธ)
นอกจากนี้ `opsOf` ให้ `fill` กับ `input` ทุกชนิดรวมถึง checkbox/radio/submit ซึ่งสั่งไม่ได้จริง

---

## 3. สิ่งที่แก้ไปแล้ว

### 3.1 ตัดวงจร chain ค้างถาวร — `browser-agent.service.ts`

เพิ่ม deadline ต่อ run หนึ่งครั้ง และทิ้งเบราว์เซอร์ที่ไม่ยอมกลับมา:

- `withRunDeadline()` — race ระหว่าง run กับ deadline (`BROWSER_AGENT_RUN_TIMEOUT_MS`, ค่าเริ่มต้น 90 วิ)
  chain จะเดินหน้าต่อเมื่อ **ครบกำหนด** ไม่ใช่เมื่อ run คืนค่าเท่านั้น
- `discardWedgedAgent()` — ล้าง `activeAgent` **ก่อน** await เพื่อไม่ให้ run ถัดไปหยิบซากไปใช้
  แล้วค่อย `agent.stop()` แบบ best-effort
- `BrowserAgentWedgedError` — ข้อความบอกตรง ๆ ว่าเบราว์เซอร์ถูกทิ้งและครั้งถัดไปจะเริ่มใหม่
- deadline (90 วิ) ตั้งให้ **ต่ำกว่า** เพดาน 120 วิ ของ tool โดยตั้งใจ เพื่อให้ได้สาเหตุจริง
  (proxy ที่ไม่ตอบ / navigation ที่ค้าง) แทนข้อความ timeout เปล่า ๆ

ผลลัพธ์: run ที่ค้างกลายเป็นความล้มเหลว **ครั้งเดียว** ไม่ใช่ความล้มเหลวถาวรของทั้งระบบ

### 3.2 ตรวจ proxy ก่อนเปิดเบราว์เซอร์ — `probeBrowserProxy()`

เพิ่มการ probe TCP ไปที่ host:port ของ `MAGNITUDE_PROXY_URL` (ใช้ `isPortListening` เดิม)
ก่อนสร้าง agent ถ้าไม่มีอะไรฟังอยู่ จะคืนข้อความที่บอกสาเหตุและทางออกทันที
แทนที่จะเปิด Chromium ที่จะค้างทุก request แล้วลากไปสู่ 2.1
เรียกใช้ทั้งใน `browser_action` (`magnitude-browser.ts:223`) และ `POST /magnitude/start`

### 3.3 locator ทนทานขึ้น — `dom-browser.service.ts`

- `ARIA_ROLES` + `roleForLocator()` — กรอง role ที่ Playwright รับได้จริง ถ้า role ใช้ไม่ได้
  จะไม่เรียก `getByRole` (ซึ่งเดิมโยน error) แต่ถอยไปใช้ text หรือ tag แทน
- `resolveCandidate()` — ลอง locator ตามลำดับความแม่น (role+name exact → role+name → placeholder →
  label → text → tag) และเลือกตัวแรกที่ **match จริงบนหน้าปัจจุบัน** แทนที่จะรวมด้วย `.or()`
  (ซึ่งเลือกตามลำดับ DOM และอาจกด container แทนตัว control)
- ถ้าไม่ match เลย จะได้ error ที่บอกให้ snapshot ใหม่ ไม่ใช่ timeout 15 วิ
- locator ที่โมเดลส่งมาเอง (เช่น `role: "div"`) จะถูกปฏิเสธพร้อมรายการ role ที่ใช้ได้

### 3.4 ลด context ต่อ action — `magnitude-browser.ts`

- `AFTER_ACTION_TEXT_CHARS = 1000` — ข้อความหลัง action เหลือ 1,000 ตัวอักษร (จาก 3,000)
- `lastTableByPage` (WeakMap) — ถ้าตาราง element ไม่เปลี่ยน จะไม่ส่งซ้ำ 120 บรรทัด
  แต่บอกว่า "unchanged — ids เดิมยังใช้ได้ และถ้าไม่มีตารางแล้วให้สั่ง snapshot"
- `needsElements` — อ่าน element เฉพาะเมื่อ action ต้องใช้ `element_id` หรือเป็น `snapshot`
  (เดิมอ่านทุก action รวมถึง `navigate` / `scroll` ที่ไม่ต้องใช้เลย)

### 3.5 ปฏิเสธ action ที่ element ทำไม่ได้ — `unsupportedElementAction()`

ตรวจ `ops` จาก snapshot ก่อนลงมือ สำหรับ `fill` / `select` / `check`
(`click` อนุญาตเสมอ เพราะการโฟกัสช่องกรอก การกดผ่าน label และการ toggle checkbox ล้วนเป็น click)
เปลี่ยน timeout 15 วิ ให้เป็นข้อความที่แก้ได้ทันที

### 3.6 hint เมื่อเข้าถึงเป้าหมายไม่ได้ — `browserReachabilityHint()`

เมื่อ error เข้าเค้า `net::ERR_*` / navigation timeout จะต่อท้ายคำอธิบายว่าสาเหตุคือ
เบราว์เซอร์รันข้าง backend ไม่ได้อยู่บน attack box พร้อมทางเลือกสองทาง (proxy ที่ยิงถึง
หรือใช้เครื่องมือบน attack box ผ่าน shell) เพื่อไม่ให้โมเดลลอง navigation เดิมซ้ำ

### 3.7 เลิกใช้เส้นทาง vision อย่างเป็นทางการ

ก่อนหน้านี้การไม่ใช้ vision เป็นเพียง "เราไม่เรียกมัน" ซึ่งเปราะ เพราะโค้ดของ Magnitude
ที่มาพร้อม dependency ยังมี `agent.act(goal)` อยู่ และสคริปต์ตรวจสอบของเราก็ยังเรียกมัน

- `scripts/browser-agent-live-check.ts` — เปลี่ยนไปขับหน้าด้วย DOM path
  (`runDomAction` + `snapshotPage`) แทน `agent.act(goal)` ยังคงวัตถุประสงค์เดิม
  (พิสูจน์ว่า agent ตัวเดิมถูกใช้ซ้ำ: cold vs warm) แต่ไม่มีการเรียก vision
  และไม่มีการจับ/อ่านภาพเลย
- `tests/visionFreeBrowser.test.ts` — **guard ระดับซอร์สโค้ด**: สแกนทุกไฟล์ `.ts`
  ใต้ `src/` และ `scripts/` (ตัด comment ออกก่อนตรวจ) แล้ว fail ถ้าพบการเรียก
  `agent.act(` หรือการอ้างถึง vision model กลับมา พร้อมระบุชื่อไฟล์ที่ผิด
  ถ้ามีคนเผลอเปิดเส้นทาง vision อีก จะรู้ตอนรันเทสต์ ไม่ใช่ตอน production พัง
- เทสต์ตัวที่สอง (`the guard actually walks the tree`) กันปัญหา guard ที่สแกนไม่เจอไฟล์อะไรเลย
  แล้วผ่านตลอดกาล — และผมทดสอบ guard นี้ด้วยการใส่ไฟล์ที่เรียก `agent.act` จริง
  ผลคือ fail ตามที่ควร แล้วลบไฟล์ทดสอบทิ้ง

ผลลัพธ์: **ไม่มีจุดใดในโปรเจกต์ที่ต้องใช้ vision model อีก** — โมเดลที่ assign ให้ Browser Agent
ทำหน้าที่เพียงสร้าง client ของ Magnitude เท่านั้น จึงเลือกโมเดล text-only ราคาถูกได้

### 3.8 บั๊กที่เจอจากการรันจริง และแก้แล้ว

รัน `scripts/browser-dom-check.ts` ในคอนเทนเนอร์จริง (คัดลอกซอร์สที่แก้แล้วไปไว้ในไดเรกทอรีแยก
`/usr/src/backend/verify` เพื่อไม่แตะโค้ดที่รันอยู่ แล้วลบออกเมื่อเสร็จ) ผลคือ **PASS 15/15**
พร้อมแก้ 2 บั๊กที่การรันเผยให้เห็น:

| บั๊ก | อาการ | แก้ |
|---|---|---|
| `__name is not defined` (2.6) | `page.evaluate` ล้มก่อนอ่าน element แรก เมื่อรันด้วย tsx | `ensurePageHelpers()` — ติดตั้ง shim `__name = (v) => v` หนึ่งครั้งต่อ page ซึ่งเป็นฟังก์ชันที่ transpiler กำลังเรียก |
| label ซ้ำกับช่องกรอก (2.7) | ตารางมี 2 แถวต่อ 1 ช่อง โมเดลเลือกผิดแถว | ตัด `<label>` ออกเมื่อ control ที่มันชี้อยู่ถูกเก็บไว้แล้ว — เก็บ label ไว้เฉพาะกรณีที่เป็น control เดียวที่มองเห็น (custom checkbox บน hidden input) |
| checkbox โฆษณา `fill` (2.7) | โมเดลสั่ง action ที่ element ปฏิเสธ | `fill` ให้เฉพาะ input ชนิดข้อความ / textarea / textbox / searchbox |

ตาราง element หลังแก้ (สะอาด หนึ่งแถวต่อหนึ่ง control):

```
[1] textbox    Username — fill
[2] textbox    Password — fill
[3] combobox   Role = "Viewer" — select
[4] checkbox   Accept terms = "on" — check
[5] button     Sign in — click
[6] link       Need help? — click
```

และเพิ่มการตรวจ 2 ข้อนี้เข้าไปในสคริปต์ (`a checkbox does not offer fill`,
`a label is not listed beside its own control`) เพื่อกันไม่ให้กลับมา

### 3.9 เทสต์

`backend/tests/browserAgentService.test.ts` — 12 เทสต์ ผ่านทั้งหมด รวมเทสต์ regression ของ 2.1
และ `backend/tests/visionFreeBrowser.test.ts` — 2 เทสต์ (guard ของหัวข้อ 3.7):

```
a run that never settles releases the chain instead of wedging it
```

เทสต์นี้ยืนยันว่า run ที่ไม่ settle จะถูกตัดด้วย deadline **และ run ถัดไปยังผ่านได้**
(ถ้าใครเผลอถอด guard นี้ออก เทสต์จะ fail ทันที) พร้อมเทสต์ของ `probeBrowserProxy`,
`roleForLocator` และ `unsupportedElementAction`
`npx tsc -p tsconfig.json --noEmit` ผ่านสะอาด

### 3.10 รอหน้าให้ settle ก่อนอ่าน และยืนยันผลหลัง action

สองสิ่งที่ค้างไว้ตั้งแต่ต้น และเป็นเหตุผลที่ run หนึ่งดูเหมือน "agent โง่" ทั้งที่มันทำถูก

**ปัญหา:** `runDomAction()` คืนค่าทันทีที่ dispatch event เสร็จ — **ก่อน**ที่ request ที่มันเริ่ม
จะกลับมา และก่อนที่ framework จะ paint ผลลัพธ์ จากนั้น `magnitude-browser.ts` อ่าน snapshot
ทันที ผลคือการอ่านนั้นบรรยาย**สถานะก่อน action** ไม่ใช่หลัง — model เห็นการกระทำของตัวเอง
เป็น "ไม่มีอะไรเกิดขึ้น" แล้ว retry หรือรายงานว่าล้มเหลวทั้งที่สำเร็จ

**แก้ 2 ส่วน:**

1. `settlePage(page, budget)` — เรียกหลังทุก action ที่เปลี่ยนหน้าได้ รอ 2 อย่าง
   (อย่างใดอย่างหนึ่งเดี่ยว ๆ พลาดเคสจริง):
   - **network idle** — click ที่ submit form ยังไม่จบตอน click คืนค่า
   - **DOM หยุดเปลี่ยน** (MutationObserver, quiet window 400ms) — framework paint ช้ากว่าหนึ่ง tick
   ทุกอย่างมีขอบเขต (`SETTLE_BUDGET_MS=5s`) และกลืน error: หน้าที่ poll ตลอดจะไม่มีวัน idle
   และการไม่ยอมไปต่อจะเปลี่ยน "หน้าช้า" ให้กลายเป็น "run พัง"

2. `verifyAction()` — บรรทัดผลลัพธ์บอกว่า**หน้าเปลี่ยนอะไร** ไม่ใช่แค่ dispatch สำเร็จ
   `clicked Sign in` คือคำกล่าวเกี่ยวกับ *ความพยายาม* ไม่ได้บอกว่ามีอะไรเกิดขึ้น
   - `fill` / `select` → อ่านค่ากลับ เทียบกับที่สั่ง (`did not keep the value`)
   - `check` → อ่าน `isChecked()` กลับ เทียบกับเจตนา
   - `click` / `press` / navigation → เทียบ fingerprint ของหน้า (URL + ความยาว + digest)
     ถ้าไม่เปลี่ยน → บอกตรง ๆ ว่า `the page did not change` แทนที่จะรายงานว่าสำเร็จ

**พิสูจน์ด้วยการวัด** (`scripts/browser-dom-check.ts` 4 ข้อใหม่) และพิสูจน์ย้อนกลับด้วย:
ถอด `settlePage` ออก → check ที่ 1 รายงานว่า `clicked "Load results" — but the page did not change`
ทั้งที่ผลลัพธ์ `3 results` มาถึงจริงในอีก 250ms — **ตรงกับอาการที่ describe ไว้เป๊ะ**

**สิ่งที่ settle ทำไม่ได้ (เขียนไว้ตรง ๆ ในโค้ด):** หน้าที่เปลี่ยนโดยไม่มี request และไม่มี mutation
นานกว่า quiet window (เช่น `setTimeout` หลายวินาที) — ไม่มี heuristic ไหนเห็นล่วงหน้า
และการรอนานพอจะจับมันได้จะเพิ่ม delay ให้ทุก action บนทุกหน้า
เคสที่มาจาก request ถูกครอบด้วย network-idle ซึ่งเป็นเคสที่หน้าจริงผลิตออกมา

### 3.11 บั๊กที่เจอเพราะ 3.10 — shim `__name` หายเมื่อหน้า navigate

`collectElements()` รันในหน้าเว็บ และโค้ดที่ serialize ไปมี `__name(...)` ที่ esbuild
(`keepNames`) ใส่ให้ฟังก์ชันที่มีชื่อ — ตัวช่วยนี้ไม่มีในหน้าเว็บ จึงตายด้วย
`ReferenceError: __name is not defined` ตั้งแต่ยังไม่อ่าน control ตัวแรก
(บันทึกไว้แล้วใน 2.6)

**ของเดิมกันไว้ด้วย `WeakSet` keyed ที่ page object** = "page นี้พร้อมแล้ว"
ซึ่งผิดในเคสเดียวที่สำคัญ: shim อยู่บน `window`, การ navigate เปลี่ยน `window`,
และ agent navigate ทุกขั้น → **collector ทำงานได้จนถึงการ navigate ครั้งแรก แล้วตายทุกครั้งถัดไป**

เดิมไม่เจอเพราะสคริปต์ตรวจ navigate ครั้งเดียวตลอดการรัน — พอ 3.10 เพิ่มหน้าที่สอง
มันตายทันที

ลองวิธีที่ควรเป็นก่อน: `page.addInitScript()` — **ใช้ไม่ได้กับเบราว์เซอร์ตัวนี้**
วัดแล้วว่า marker ที่ตั้งผ่าน init script หายไปแม้แต่ในการโหลดครั้งแรกสุด
จึงต้องติดตั้ง shim เองก่อนทุกบล็อกที่ evaluate (ต้นทุน 1 round trip ต่อการอ่าน)
ตัวติดตั้งเองใช้แต่ anonymous arrow จึงทำงานได้ในเอกสารที่ยังไม่มี shim — ซึ่งเป็นสิ่งที่ตัดวงจร

> หมายเหตุ: `tsc` ไม่ได้ใส่ helper นี้ ดังนั้น production (`node dist/server.js`) ไม่มีอาการนี้
> — กระทบเฉพาะเส้นทาง tsx (สคริปต์ตรวจและเทสต์) ซึ่งทำให้**เครื่องมือตรวจจับเคส multi-navigation
> ไม่ได้** จนกว่าจะแก้

---

## 4. แก้แล้ว — ย้ายเบราว์เซอร์ไป attack box (ข้อ 2.2)

> **อัปเดต:** เลือกทาง **B** และลงมือทำแล้ว หัวข้อนี้เก็บไว้เป็นบันทึกการตัดสินใจ

### ทางเลือกที่พิจารณา

| ทางเลือก | ทำอะไร | ข้อดี | ข้อเสีย |
|---|---|---|---|
| A. คงเบราว์เซอร์ไว้ที่ backend | ให้ผู้ใช้ตั้ง proxy ที่ backend ยิงถึง | แก้โค้ดน้อยที่สุด | เป้าหมายที่ไม่ผ่าน HTTP proxy ใช้ไม่ได้ และไม่ปิดรูเรื่อง fence |
| **B. ย้ายเบราว์เซอร์ไป attack box** ✅ | รัน Chromium บน attack box สั่งผ่าน SSH/CDP | เบราว์เซอร์อยู่ที่เดียวกับ VPN และเครื่องมืออื่น | งานใหญ่ |
| C. เลิกใช้เบราว์เซอร์กับเป้าหมายหลัง VPN | ใช้ curl/ffuf/sqlmap | ต้นทุนศูนย์ | เสียความสามารถ JS-heavy app, CSRF flow, multi-step login |

### B ถูกลงกว่าที่ประเมินไว้ตอนแรกมาก

การสำรวจพบว่า **`magnitude-core` ถูกใช้จริงที่เดียวในทั้งโปรเจกต์** —
บรรทัด `startBrowserAgent()` ใน `browser-agent.service.ts` (ที่เหลือเป็นคอมเมนต์)
และ `patchright` เป็น dependency ตรงอยู่แล้ว, `ssh2` ก็มีอยู่แล้ว

จึง **ไม่ต้องสร้าง CDP relay หรือ RPC layer ใหม่เลย** — เปลี่ยนแค่ "จุดที่เปิดเบราว์เซอร์"
จาก local → attack box แล้วต่อกลับด้วย CDP ส่วน `dom-browser.service.ts` ที่เขียนไว้แล้ว
ทำงานต่อได้เหมือนเดิมทุกบรรทัด

### สิ่งที่ทำจริง

| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `kali/Dockerfile` | เพิ่ม layer เดี่ยว `apti chromium` (ไม่ใส่ใน Layer 4 เพื่อไม่ให้ layer `kali-linux-*` ที่แพง rebuild) |
| `backend/src/services/remote-browser.service.ts` | **ใหม่** — launch Chromium บน attack box ผ่าน SSH, เปิด tunnel, `connectOverCDP`, `waitForCdp`, `proxyUrlForAttackBox`, `shellQuote` |
| `backend/src/services/browser-agent.service.ts` | สลับ `ensureBrowserAgent` เป็น remote/local, fingerprint แยกตามโหมด, `probeBrowserProxy` ตรวจผ่าน SSH |
| `backend/src/services/burp-ca.service.ts` | profile ชี้ `/kali-data/chromium-home` (bind mount ร่วม) และแยกที่มาของ CA ออกจาก `MAGNITUDE_PROXY_URL` |
| `kali/entrypoint.sh` | **ไม่**เปิด Chromium ที่นี่ — ให้ backend สั่งเปิด เพื่อให้ค่าใน Settings ยังมีผล |

### จุดออกแบบ 3 ข้อที่ต้องตัดสินใจระหว่างทาง

**1. ใครเป็นคนเปิด Chromium — entrypoint หรือ backend?**
เลือก **backend** ถ้า entrypoint เป็นคนเปิด flag ของ Chromium จะถูก fix ตั้งแต่ container start
แปลว่าค่า proxy ที่ตั้งในหน้า Settings **จะไม่มีผลอีก** และ fingerprint/deadline guard/idle stop
ที่มีอยู่จะสูญความหมาย

**2. transport — SSH tunnel หรือเปิด CDP port ตรง ๆ?**
เลือก **SSH tunnel** CDP ไม่มี authentication ถ้าเปิดบน network ใครก็ตามที่อยู่ network เดียวกัน
(ใน prod คือ `control`/`fenced`) สั่งเบราว์เซอร์ได้ — ซึ่งเป็นเบราว์เซอร์ที่ถือเส้นทาง VPN
tunnel ผูกกับ loopback ทั้งสองฝั่ง จึงไม่มี port ใหม่ถูก publish เลย

**3. NSS trust store — ใครติดตั้ง Burp CA?**
profile ถูกวางไว้ที่ `/kali-data/chromium-home` ซึ่ง **bind mount เข้า container ทั้งสองที่ path เดียวกัน**
backend จึงเขียน NSS db (`certutil`) ลงไปได้ตรง ๆ แล้ว Chromium ฝั่ง kali อ่านเจอ
ไม่ต้อง SSH ไปรัน certutil ทีละใบ

### ผลข้างเคียงที่ดี: ปิดรูของ egress fence

`docs/EGRESS-FENCE.md` เคยระบุเองว่าเบราว์เซอร์เป็น **"รูเดียวที่ topology ปิดไม่ได้ด้วยตัวเอง"**
เพราะรันใน backend ซึ่งต้องคุย Mongo/Redis/model API จึง isolate ไม่ได้ ทำได้แค่ตั้งค่า proxy ให้ถูก
การย้ายไป attack box ทำให้เบราว์เซอร์ **อยู่ใน fenced network เหมือนเครื่องมืออื่น** — fence ตัดสินที่ wire
แทนที่จะพึ่งการตั้งค่าถูกต้อง ดูรายละเอียดที่ `docs/EGRESS-FENCE.md`

### ผลข้างเคียงที่ดีอีกข้อ: จอ Desktop เห็นเบราว์เซอร์โดยไม่ต้องเขียนโค้ดเพิ่ม

เดิมเบราว์เซอร์วาดบน Xvfb `:99` ของ **backend** ซึ่งเป็นจอที่ผู้ใช้ไม่เคยเห็น (หน้า Desktop ไปไม่ถึง)
ย้ายมาแล้วมันวาดบน Xvnc `:89` ของ **attack box** ซึ่งเป็นจอเดียวกับที่หน้า Desktop แสดงอยู่แล้ว

ไม่ต้องแก้อะไรเลย: `vnc.controller.ts` หา desktop จาก `resolveSessionWorkHost()` อยู่แล้ว และ
`resolveWorkHostRecords()` ตกลงมาที่ **attack box ของ environment** เมื่อ workspace ไม่ได้ตั้ง work host ไว้
(บรรทัดที่คอมเมนต์ว่า record แบบ local ถูกยกเลิกไปแล้ว) — ปลายทางจึงเป็นกล่องเดียวกันกับที่เบราว์เซอร์รัน

ผลคือผู้ใช้เห็น Chromium ทำงานสด ๆ บนหน้า Desktop ระหว่างที่ agent ใช้งาน ซึ่งเป็นสิ่งที่โหมด headful ควรได้ตั้งแต่แรก

### บั๊ก 5 ตัวที่เจอจากการรันจริง (ไม่ใช่จากการอ่านโค้ด)

ทั้งสี่ตัวผ่าน `tsc` และ eslint เรียบร้อย และผ่าน unit test — เจอได้เพราะรัน
`scripts/browser-remote-check.ts` กับ Chromium บน attack box จริงเท่านั้น

**บั๊กที่ 1 — `pkill` ฆ่า shell ของตัวเอง**
คำสั่งเปิด Chromium เดิมรวม `pkill -f '[r]emote-debugging-port=9222'` ไว้ในคำสั่งเดียวกัน
แต่คำสั่งนั้น**มี `--remote-debugging-port=9222` อยู่ในบรรทัดคำสั่งของ shell เอง**
`pkill -f` จึงแมตช์ shell นั้นและฆ่ามันทิ้งก่อนถึง `echo LAUNCHED`

อาการที่เห็นคือ `Could not start Chromium on the attack box: (no output)` — ไม่มี output เลย
ทั้งที่รันคำสั่งเดียวกันในคอนเทนเนอร์ตรง ๆ สำเร็จ (เพราะ stdin ไม่มีสตริงนั้นในบรรทัดคำสั่ง)

แก้โดยแยก kill ออกเป็น SSH call ต่างหาก

**บั๊กที่ 2 — ส่ง display ของ backend ไปให้ attack box**
`MAGNITUDE_DISPLAY=":99"` คือ Xvfb ของ **backend** แต่ถูกส่งต่อไปเป็น `DISPLAY` ของ Chromium
บน **attack box** ซึ่งไม่มี X server ที่ `:99` (ของมันคือ Xvnc ที่ `:89`)
Chromium จึงตายทันทีด้วย `Missing X server or $DISPLAY`

ตัวนี้อันตรายเพราะจะกระทบการใช้งานจริง ไม่ใช่แค่สคริปต์ตรวจ — แก้โดยแยกเป็น
`BROWSER_AGENT_DISPLAY` (ค่า default `:89`) ใช้เฉพาะโหมด remote

**บั๊กที่ 3 — เบราว์เซอร์ไม่เคยถูกปิดจริง (`browser.close()` ไม่ฆ่า process)**

ตัวนี้อันตรายที่สุดในสามตัว และเจอเพราะ**วัด ไม่ใช่เพราะอ่านโค้ด**

`startRemoteAgent()` คืน `stop()` ที่เรียก `browser.close()` แล้ว `tunnel.close()`
พร้อมคอมเมนต์ยืนยันว่า *"browser.close() over CDP terminates the remote Chromium"*

**คอมเมนต์นั้นไม่จริง** Playwright ไม่ฆ่าเบราว์เซอร์ที่ต่อด้วย `connectOverCDP()`
หลักฐานจากการวัดแบบควบคุม:

```
1. pkill chromium บน attack box          → เหลือ 0 process
2. รัน scripts/browser-remote-check.ts   → verdict: PASS (0 failed)
3. นับ process ทันทีที่สคริปต์จบ          → เหลือ 10 process
```

`--user-data-dir=/kali-data/chromium-home/profile` และ `--remote-debugging-port=9222`
ยังอยู่ครบ แปลว่าเบราว์เซอร์ **ยังกิน memory, ถือ profile และถือ connection ไป proxy อยู่**

ผลกระทบจริง: ทุกครั้งที่ idle release ทำงาน (หรือ `stopBrowserAgent()` ถูกเรียก)
สิ่งที่เกิดขึ้นคือ "ตัดการเชื่อมต่อ" ไม่ใช่ "ปล่อยคืน" — เบราว์เซอร์อายุยืนกว่า run ที่เปิดมัน
และไม่มีอะไรต่อกลับไปหาได้อีก ซึ่งเป็นอาการที่คอมเมนต์อ้างว่าหลีกเลี่ยงได้
(โชคดีที่ `launchRemoteChromium()` เรียก `killRemoteChromium()` ก่อนเปิดใหม่
process จึงไม่ทับถมเกิน 1 ตัว — แต่ทรัพยากรไม่ได้คืนตอนที่ควรคืน)

**ทำไมบั๊กนี้ซ่อนได้นาน:** บรรทัดที่ควรจับมันเป็น tautology

```ts
await browser.close();
check("the browser closed cleanly", true);   // ← ยืนยัน `true` เสมอ
```

ไม่ได้ตรวจว่า process หายไปไหม ตรวจแค่ว่า `browser.close()` ไม่ throw

แก้ 3 จุด:
1. `stop()` เรียก `await killRemoteChromium(port)` ต่อจาก `browser.close()` และแก้คอมเมนต์ให้ตรงความจริง
2. สคริปต์ตรวจเปลี่ยนเป็นยืนยันจริง — `pgrep` ต้องไม่เหลือ process หลัง stop
3. เพิ่ม unit test แบบ source guard (`tests/browserAgentService.test.ts` #24)
   และ**พิสูจน์แล้วว่า test นี้ fail จริงเมื่อถอด fix ออก** (ไม่ใช่ tautology อีกตัว)

อนึ่ง สคริปต์ตรวจยังมีบั๊กพ่วงอีกข้อ: บรรทัด log พิมพ์ proxy ที่ rewrite แล้ว
(`-> http://127.0.0.1:8080/`) แต่ตอน `launchRemoteChromium({ proxyUrl })` ส่งค่า**ดิบ**
(`http://kali:8080`) — บน attack box ชื่อ `kali` คือตัวมันเอง จึงบังเอิญใช้ได้
แต่ log ที่พิมพ์ไม่ตรงกับสิ่งที่รันจริง แก้ให้ใช้ค่าเดียวกัน (`launchedProxy`)

**บั๊กที่ 4 — recreate attack box แล้วเบราว์เซอร์เปิดไม่ได้อีกเลย (profile lock ค้าง)**

ตัวนี้เจอตอน **recreate `vulnpen-kali` จากอิมเมจที่ build ใหม่** ซึ่งเป็นขั้นตอนปกติที่สุด
ของการ deploy — และมันทำให้ browser agent **ตายถาวร** จนกว่าจะมีคนไปลบ lock ด้วยมือ

อาการ: ทุกอย่างก่อนหน้านี้ผ่านหมด แต่พอ recreate แล้ว check ล้มพร้อมกัน

```
PASS  Chromium is running on the attack box — pid 677
FAIL  Chromium draws on the attack box's desktop display — /proc/677/environ: No such file or directory
FAIL  the remote browser chain completed — did not open its debug port within 30s
```

`pid 677` มีอยู่จริงตอนตรวจ แต่**ตายไปแล้ว**ตอนอ่าน `/proc` — และ `/tmp/chromium.log`
บน attack box บอกสาเหตุตรง ๆ:

```
The profile appears to be in use by another Chromium process (23323)
on another computer (846f31541adc).
```

ตรวจ lock แล้วตรงกับที่ log ว่าเป๊ะ:

```
SingletonLock -> 846f31541adc-23323     ← hostname ของ container ที่ถูกทำลายไปแล้ว
hostname ของ container ปัจจุบัน          → 9ecd50cb908b   (คนละตัว)
```

**กลไก:** profile อยู่บน `/kali-data/chromium-home` ซึ่งเป็น **bind mount ที่ตั้งใจให้อยู่รอด**
container (นั่นคือสิ่งที่ทำให้ backend ติดตั้ง Burp CA ลง NSS store ได้) Chromium เก็บ
`SingletonLock` เป็น symlink ที่**ฝัง hostname ของเครื่องที่ถือ lock อยู่**
พอ recreate container → hostname เปลี่ยน → Chromium เห็นว่า "เครื่องอื่นถือ profile อยู่"
แล้ว **ปฏิเสธที่จะเปิดเลย** ไม่มีกลไกไหนล้าง lock ให้เอง

ผลกระทบจริง: **ทุกครั้งที่อัปเดตอิมเมจหรือ `up -d --no-deps kali`** browser agent จะใช้ไม่ได้
ถาวร และข้อความ error ไปโทษ container ที่ตายไปแล้ว ซึ่งชี้ออกจากสาเหตุจริง
(`killRemoteChromium()` ช่วยไม่ได้ — มันฆ่าได้แค่ process บนเครื่องปัจจุบัน)

แก้โดยให้คำสั่ง launch ลบ `SingletonLock` / `SingletonCookie` / `SingletonSocket`
ก่อนเปิดเสมอ ปลอดภัยเพราะ `launchRemoteChromium()` สั่ง kill ก่อนแล้ว
lock ที่รอดถึงจุดนั้นจึงเป็น lock ค้างโดยนิยาม — และลบแค่ 3 ไฟล์นี้
ไม่แตะ profile (ซึ่งถือ CA ของ Burp อยู่)

พิสูจน์แล้วว่าจริงทั้งขาไปขากลับ: สร้างสถานการณ์ lock ค้างจริง → check **PASS 11/11**
และ test ใหม่ fail เมื่อถอด fix ออก

**บั๊กที่ 5 — ค่า `--proxy-server` มี trailing slash → proxy ใช้ไม่ได้ทั้งเส้น**

ตัวนี้อันตรายกว่า 4 ตัวแรกเพราะ **ไม่มีอะไรฟ้อง** — config ถูก, Burp เปิดอยู่, CA ติดตั้งแล้ว
แต่ทุก request ที่ออกจากเบราว์เซอร์ล้มด้วย `net::ERR_NO_SUPPORTED_PROXIES`
แปลว่า **โหมด remote browser ใช้ proxy ไม่ได้เลยใน production** ตั้งแต่แรก
และบั๊กนี้ถูก **unit test ที่มีอยู่ยืนยันว่าถูกต้อง** (ดูหัวข้อถัดไป)

เจอตอนเขียน check ของ Burp CA (§9) แล้วเจอ error ที่อธิบายไม่ได้รอบเดียว
ซึ่งตามที่เขียนค้างไว้ตอนนั้นว่า "อธิบายไม่ได้ ⇒ ไม่ถือว่าปิด" — จึงตามจนเจอ

รากของปัญหา: `proxyUrlForAttackBox()` สร้างค่าด้วย `URL` แล้วคืน `url.href`
ซึ่ง **`href` ต่อ trailing slash ให้เสมอ** (`http://127.0.0.1:8080` → `http://127.0.0.1:8080/`)
แต่ `--proxy-server` ของ Chromium รับได้ **เฉพาะ `scheme://[user:pass@]host:port`**
เจอ `/` ต่อท้าย → Chromium ตีความเป็น proxy list ที่ว่างเปล่า → ไม่มี proxy ให้ใช้ → ล้มทุก request

พิสูจน์แบบแยกตัวแปร (ไม่ใช่เดา):

```
1) ล้าง /kali-data/chromium-home ทั้งหมด → reproduce 3/3
2) เทียบกับ proxy เดียวกันแต่ตัด slash → ERR_CERT_AUTHORITY_INVALID / OK
3) ใส่ slash กลับ → ERR_NO_SUPPORTED_PROXIES 2/2
   (fail ทั้งขาไปขากลับ ⇒ สาเหตุคือ slash ไม่ใช่ cache/CA/ตัวแปรอื่น)
```

แก้โดยประกอบ URL จากชิ้นส่วนเองแทน `href`:

```ts
const auth = url.username
  ? `${url.username}${url.password ? `:${url.password}` : ""}@`
  : "";
return `${url.protocol}//${auth}${url.host}`;
```

**บั๊กที่ 5 ทำ test ที่มีอยู่พังไปด้วย** — มี 2 เทสต์ที่ assert ค่าเป็น `"http://127.0.0.1:8080/"`
คือ **เทสต์เขียนบั๊กไว้ในตัว** แล้วผ่านมาตลอด (test เขียว = บั๊กอยู่ครบ)
แก้เทสต์ทั้งสองให้ assert ค่าไม่มี slash และเพิ่มเทสต์ใหม่กันการถอยหลัง:
`the proxy value never carries a trailing slash or a path` (คุม socks5 / มี credentials / IPv6)

### ยังเหลือ

- `magnitude-core` ยังเป็น dependency (ใช้เฉพาะโหมด local fallback `BROWSER_AGENT_REMOTE=false`)
- ~~ยังไม่ได้ทำ: ยืนยันผลหลังการกระทำ, settle wait ก่อนอ่าน snapshot หลัง action~~
  → **ทำแล้ว** ดู §3.10 (พร้อมบั๊กที่มันไปเปิดโปงใน §3.11)

---

## 5. ทำไมระบบยังต้องใช้ screenshot ทั้งที่โมเดลอ่านรูปได้

ประเด็นสำคัญก่อนตอบ: **ในโค้ดปัจจุบัน ระบบไม่ต้องใช้ screenshot ใน action loop แล้ว**

`dom-browser.service.ts` และ `magnitude-browser.ts` ถูกออกแบบมาให้อ่านหน้าเป็น DOM
ไม่ใช่เป็นภาพ — พารามิเตอร์ `screenshot` เป็น **opt-in** (ค่าเริ่มต้น `false`) และเมื่อเปิด
ภาพจะถูกส่งให้ **คนอ่าน transcript** เท่านั้น ไม่มีโค้ดส่วนใดอ่านภาพกลับ
(doc comment ใน `magnitude-browser.ts`: "No screenshot is taken as part of the action loop.")

ที่ "ต้องใช้ screenshot" คือ **เส้นทางเดิม** ของ Magnitude (`agent.act(goal)`) ซึ่งอ้างอิงโมเดลวิชันขนาดเล็ก
(Moondream) เพื่อหา **พิกัด** ของจุดคลิก เหตุผลที่ยังต้องมี screenshot-per-step ในดีไซน์แบบนั้น
(และเหตุผลที่การย้ายไป DOM path เป็นการแก้ที่ถูกทาง) มี 7 ข้อ:

1. **"อ่านภาพได้" ≠ "ชี้พิกัดได้"** — การเข้าใจภาพเป็นความสามารถเชิงความหมาย (semantic)
   แต่การแปลง "กดปุ่ม Sign in" เป็นพิกัด (x, y) เป็นความสามารถเชิงพื้นที่ (grounding) ที่แยกกัน
   และแม่นยำน้อยกว่ามาก จึงต้องมีโมเดลเฉพาะทางมาหาพิกัดให้ โมเดลหลักไม่ได้ให้พิกัดที่เชื่อถือได้

2. **ต้นทุนและเวลา** — ภาพ 1280×800 หนึ่งใบกินประมาณ 1,000–1,500 โทเคน และต้องส่งใหม่ทุกขั้น
   ตอนที่หน้าจอเปลี่ยน เทียบกับตาราง element ที่กินโทเคนพอ ๆ กัน **แต่แคชได้และไม่เปลี่ยนตาม scroll**
   ยิ่งไปกว่านั้นผู้ให้บริการมักย่อภาพลง (downscale) ทำให้ข้อความเล็ก ๆ ในภาพอ่านผิดได้ง่าย

3. **ความแน่นอน (determinism)** — พิกัดเป็นสิ่งที่ตรวจสอบย้อนหลังไม่ได้ ถ้า scroll 1 พิกเซล
   animation ขยับ หรือ resize พิกัดนั้นก็ผิดทันที และไม่มีทางยืนยันว่า "สิ่งที่กดไปคือสิ่งที่ตั้งใจกด"
   ต่างจาก DOM handle (role + accessible name) ที่ resolve ใหม่ได้ ตรวจ occlusion ได้ และ replay ได้

4. **การยืนยันผล** — DOM ให้ทั้ง `value` ของ input, `checked` ของ checkbox, URL ใหม่
   และข้อความบนหน้า ซึ่งใช้ *ยืนยัน* ว่าการกระทำได้ผลจริง ภาพบอกได้แค่ "ดูเหมือนว่า…"

5. **ความปลอดภัยของข้อมูล** — screenshot ของ session ที่ล็อกอินแล้วมี token, PII, ข้อมูลลูกค้า
   และถูกส่งออกไปยังผู้ให้บริการโมเดลทั้งใบ ส่วน DOM path **ปิดข้อมูลได้** ซึ่งโค้ดนี้ทำอยู่จริง
   (`valueOf()` แทนรหัสผ่านด้วย `••••••` ก่อนส่งเข้า transcript) — เป็นข้อบังคับสำหรับเครื่องมือ pentest

6. **หลักฐานที่ตรวจสอบได้** — ผลิตภัณฑ์นี้ต้องการ evidence แบบ request/response ที่ทำซ้ำได้
   ไม่ใช่ภาพ ซึ่ง Burp proxy history ให้ได้และ screenshot ให้ไม่ได้

7. **ยังมีที่ที่ต้องใช้ภาพจริง** — หน้าที่เป็น `<canvas>` / WebGL / anti-bot หรือ shadow DOM ซับซ้อน
   ที่อ่าน DOM ไม่ได้ และการเก็บภาพเป็น **หลักฐานให้คน** ในรายงาน
   ดีไซน์ที่ถูกต้องจึงเป็น "**screenshot เมื่อจำเป็นและเพื่อคนอ่าน**" ไม่ใช่ "screenshot ทุกขั้นเพื่อให้โมเดลอ่าน"

สรุป: การใช้ภาพแทน DOM ไม่ได้ฟรี — มันแลกความแม่นยำ ความสามารถตรวจสอบ ต้นทุน และความปลอดภัย
ไปกับความสะดวกที่ได้มาแค่บางหน้า โค้ดปัจจุบันเลือกถูกแล้ว

และตอนนี้ไม่ใช่แค่ "เลือกใช้ DOM" แต่ **เส้นทาง vision ถูกปลดระวางและถูกล็อกไว้แล้ว** (หัวข้อ 3.7):
ไม่มีจุดใดในโปรเจกต์ที่เรียกมัน และมีเทสต์ที่จะ fail ทันทีถ้ามันกลับมา
ดังนั้นคำตอบคือ **ใช่ — ไม่ต้องใช้ vision อีกแล้ว** ทั้งใน action loop และในสคริปต์ตรวจสอบ

---

## 6. ประเมิน `browser-use/jev-ultrafast`

### 6.1 มันคืออะไร

- repo จริงของ browser-use (commit ล่าสุด ก.ย. 2026) — ภาษา **Python** (`pyproject.toml` + `uv`)
- แนวคิดหลัก: "dynamic, indexed action space" — ให้ goal มา 1 อัน, โมเดล **TypeSafe Jev**
  เลือก `operation` + `element` ในคำขอเดียว (speculative fan-out) และใช้ LLM เล็กเขียนข้อความ
  เฉพาะเมื่อ operation เป็น `TYPE_TEXT`
- operation: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP/DOWN`, `WAIT`, `DONE`, `BLOCKED`
- **ไม่มี screenshot ใน loop หลัก** — ใช้ structured state (element table) เหมือนที่เราทำ
- ต่อกับ Chrome จริงของผู้ใช้ผ่าน "Browser Harness" + remote debugging
- ต้องมี `TYPESAFE_API_KEY` (บริการโฮสต์ของ TypeSafe) และ key ของโมเดลข้อความ
- ตัวเลขที่อ้าง: Zürich → London บน Google Flights ใน 7.1 วิ, เร็วขึ้น 25%,
  browser protocol calls 1,092 → 101

### 6.2 ใช้แทนเลยหรือไม่ → **ไม่แนะนำ**

| ประเด็น | รายละเอียด |
|---|---|
| **ภาษา/รันไทม์** | เป็น Python ขณะที่ backend เป็น TypeScript + patchright การรับมาใช้คือเพิ่มรันไทม์ที่สอง sidecar process และ seam รับส่งข้อมูลใหม่ — ต้นทุนสถาปัตยกรรมสูงสำหรับสิ่งที่เรามีอยู่แล้ว |
| **พึ่งพาบริการภายนอก** | ต้องมี `TYPESAFE_API_KEY` (SaaS ของ TypeSafe) ในเส้นทาง inference ของผลิตภัณฑ์ความปลอดภัย ที่ปัจจุบันให้ผู้ใช้ "Bring your own model" พร้อมระบบ verify/assignment/consent — ขัดกับโมเดลการตั้งค่าและการ trace (Langfuse) ที่มีอยู่ |
| **โมเดลการเชื่อมเบราว์เซอร์** | มัน attach กับ **Chrome จริงของผู้ใช้** (โปรไฟล์เดิม + remote debugging) แต่เราต้องการ Chromium headless ใต้ Xvfb พร้อมโปรไฟล์ที่ trust Burp CA, ผ่าน Burp proxy และผ่าน egress fence (`MAGNITUDE_PROXY_URL`) การไปเกาะ Chrome ส่วนตัวของผู้ปฏิบัติงานคือ **ความเสี่ยงด้านความปลอดภัยย้อนกลับ** (คุกกี้/เซสชันส่วนตัว) และทำให้ proxy/fence หลุด |
| **ไม่มีชั้น safety** | กฎของผลิตภัณฑ์ (`detectDestructiveBrowserGoal`, consent batch, การปฏิเสธที่ไม่มีโหมดไหนอนุมัติได้) บังคับใช้ที่ชั้น tool ถ้าเอา agent อัตโนมัติมาแทน จะต้อง implement ซ้ำทั้งหมด |
| **ยังเป็น MVP** | README ระบุเองว่าไม่รองรับ: shadow roots, iframes, canvas, uploads, pop-up tabs, nested scrolling, arbitrary keyboard widgets และไม่ได้ implement accessible-name spec ครบ — ซึ่งคือจุดที่เป้าหมาย pentest เจอจริง (login ใน iframe, CSRF token ใน shadow DOM, ทดสอบ unrestricted file upload, OAuth หลายแท็บ) |
| **หลักฐานยังบาง** | ส่วน "Evidence and limits" ยอมรับเองว่าเป็น "three repeats of one task on one browser profile, **not a general reliability benchmark**" — ยังไม่มีหลักฐานความน่าเชื่อถือพอจะแทนที่เส้นทางที่ทำงานได้ |
| **ย้ายการควบคุม** | `jev-ultrafast` เป็น **agent loop** ที่ตัดสินใจเองจาก goal แต่ `browser_action` ของเราเป็น **tool** ที่ orchestrator สั่งทีละขั้น เพื่อสลับกับ Burp harvesting / บันทึก finding / ขอ consent การแทนที่จะดึงการควบคุมออกจาก orchestrator ซึ่งเป็นหัวใจของผลิตภัณฑ์ ("the agent is a participant in that workflow") |

### 6.3 ควรยืมอะไร (และยืมไปแล้วบางส่วน)

แนวคิดที่ **ตรงกับที่เราทำอยู่แล้ว** และไม่ต้องแก้อะไร:

- snapshot ครั้งเดียวต่อหนึ่งรอบ อ่าน control ที่มองเห็นทั้งหมดแบบ atomic พร้อม index
  → เราทำแล้วใน `snapshotPage()` (เรียก `page.evaluate` ครั้งเดียว)
- ส่งเฉพาะข้อความที่มองเห็น (ตัด offscreen ออก) → `collectText()` ตัด `script/style/hidden` แล้ว
- ไม่มี screenshot ใน loop หลัก → ตรงกัน
- ไม่ให้ output ของโมเดลกลายเป็น selector/พิกัด/JS → เราบังคับผ่าน locator ที่ validate แล้ว

แนวคิดที่ **นำมาปรับใช้ในรอบนี้แล้ว**:

- **validate the selected target** → `unsupportedElementAction()` (หัวข้อ 3.5)
  เป็นครึ่งที่ถูกและราคาถูกของการตรวจสอบนี้: ตรวจว่า element รองรับ action ที่สั่งไหมก่อนลงมือ
- **resolve current geometry และปฏิเสธ control ที่ถูกบัง** → `resolveCandidate()` ตรวจว่า
  locator match จริงบนหน้าปัจจุบันก่อนกด (หัวข้อ 3.3)

แนวคิดที่ **ควรทำต่อ** (ยังไม่ได้ทำในรอบนี้):

- **ยืนยันผลหลังการกระทำ** — หลัง click/fill ให้ตรวจว่าเกิดผลจริง (ค่าเปลี่ยน, URL เปลี่ยน,
  ข้อความที่คาดหมายปรากฏ) แล้วรายงาน "คาดว่า X แต่พบ Y" แทนที่จะเชื่อบรรทัดผลลัพธ์ของตัวเอง
  นี่คือไอเดียที่ให้ผลสูงสุดเป็นลำดับถัดไปในการลดอาการ "AI เอ๋อ"
- **รอให้หน้าอยู่ตัวก่อนอ่าน** — jev รอ suggestion สูงสุด 200 ms หลังพิมพ์ และ 2 animation frame
  หรือ 50 ms สำหรับ interaction อื่น ส่วนเราอ่าน snapshot ทันทีหลัง action จึงมีโอกาสอ่านหน้า
  ที่ยัง render ไม่เสร็จ แล้วรายงานตารางว่าง/เก่า → เพิ่ม settle wait สั้น ๆ ก่อนอ่านหลัง action
- **idempotency ของการ retry** — ค่าที่ generate ได้แล้วควรอยู่รอดข้ามการ retry
  เฉพาะเมื่อ input ไม่เปลี่ยน (jev ทำแบบนี้) มีประโยชน์ถ้าเราเพิ่ม retry ให้ browser_action

### 6.4 ข้อเสนอ

1. **ไม่แทนที่** — เหตุผลด้านรันไทม์ ภาษา การพึ่งพา SaaS และการข้ามชั้น safety ยังชี้ขาด
2. **ยืมแนวคิด** ตามหัวข้อ 6.3 โดยเริ่มจาก "ยืนยันผลหลังการกระทำ" และ "settle wait"
   ซึ่งแก้ "AI เอ๋อ" ได้ตรงจุดและไม่เพิ่ม dependency ใด ๆ
3. **ทบทวนใหม่เมื่อ** (ก) ทางเลือกสถาปัตยกรรมในหัวข้อ 4 ถูกเลือกแล้ว และ
   (ข) `jev-ultrafast` มี benchmark ความน่าเชื่อถือจริง (หลายงาน หลายเว็บไซต์) และรองรับ
   iframe / shadow DOM / upload ครบ — ตอนนั้นสิ่งที่ควรยืมคือ "dynamic action space"
   (เสนอเฉพาะ operation ที่เป็นไปได้จริงตามสถานะที่เห็น) ซึ่งเข้ากับ `unsupportedElementAction()`
   ที่เพิ่งเพิ่มไปได้พอดี

---

## 7. วิธีตรวจสอบว่าแก้ได้ผล

```bash
cd backend

# 1. เทสต์ (รวม regression ของ chain ค้าง และ guard ของเส้นทาง vision)
npx tsx --test tests/browserAgentService.test.ts
npx tsx --test tests/visionFreeBrowser.test.ts

# 2. typecheck
npx tsc -p tsconfig.json --noEmit

# 3. ตรวจ DOM path กับ Chromium จริง (ไม่เรียก provider, ไม่ใช้เครือข่าย)
npx tsx scripts/browser-dom-check.ts

# 4. ตรวจการ reuse ของ agent กับโมเดลจริง (มีค่าใช้จ่าย)
npx tsx scripts/browser-agent-live-check.ts
```

การยืนยันด้วยมือ: เปิดใช้ browser agent แล้วสั่ง `browser_action` ที่จะค้าง (เช่น proxy ที่ไม่ตอบ)
ต้องได้ข้อความบอกสาเหตุ **ครั้งเดียว** แล้วคำสั่งถัดไปต้องทำงานได้ตามปกติ —
ก่อนแก้ คำสั่งถัดไปทุกคำสั่งจะ timeout 120 วิ ติดกันจนกว่าจะรีสตาร์ต backend

ตรวจในคอนเทนเนอร์จริงโดยไม่แตะโค้ดที่รันอยู่ (คัดลอกซอร์สไปไดเรกทอรีแยก):

```bash
cd backend
tar -cf - src scripts/browser-dom-check.ts \
  | docker exec -i vulnpen-backend sh -c 'rm -rf /usr/src/backend/verify && mkdir -p /usr/src/backend/verify && tar -xf - -C /usr/src/backend/verify'
docker exec vulnpen-backend sh -c 'cd /usr/src/backend/verify && npx tsx scripts/browser-dom-check.ts'
docker exec vulnpen-backend sh -c 'rm -rf /usr/src/backend/verify'
```

ผลล่าสุด: `verdict: PASS (0 failed)` — 15/15 กับ Chromium จริง

## 8. ไฟล์ที่แก้ในรอบนี้

| ไฟล์ | แก้อะไร |
|---|---|
| `backend/src/services/browser-agent.service.ts` | run deadline + ทิ้ง agent ที่ค้าง + `probeBrowserProxy()` + `BrowserAgentWedgedError` |
| `backend/src/services/dom-browser.service.ts` | `ARIA_ROLES` / `roleForLocator()` / `resolveCandidate()` / `unsupportedElementAction()` |
| `backend/src/tools/handlers/magnitude-browser.ts` | ตรวจ proxy ก่อนเปิดเบราว์เซอร์, ลด payload ต่อ action, ตัดตารางที่ไม่เปลี่ยน, อ่าน element เฉพาะที่จำเป็น, hint เมื่อเข้าถึงเป้าหมายไม่ได้ |
| `backend/src/controllers/magnitude.controller.ts` | ตรวจ proxy ก่อนเปิดเบราว์เซอร์จากปุ่ม Start |
| `backend/src/utils/magnitudeError.ts` | `browserReachabilityHint()` |
| `backend/scripts/browser-agent-live-check.ts` | ขับหน้าด้วย DOM path แทน `agent.act()` (เลิกใช้ vision) |
| `backend/tests/browserAgentService.test.ts` | +6 เทสต์ (deadline, proxy probe, role, unsupported action) |
| `backend/tests/visionFreeBrowser.test.ts` | guard กันเส้นทาง vision ไม่ให้กลับมา |
| `backend/scripts/browser-dom-check.ts` | +2 การตรวจ (checkbox ไม่มี fill, ไม่มี label ซ้ำ) |
| `README.md`, `GLOSSARY.md` | ระบุว่าไม่ต้องใช้ vision model + เพิ่มคำศัพท์ DOM browser path / shared browser agent |

รอบที่ 2 — ย้ายเบราว์เซอร์ไป attack box (ข้อ 2.2 / §4):

| ไฟล์ | แก้อะไร |
|---|---|
| `backend/src/services/remote-browser.service.ts` **(ใหม่)** | launch / tunnel / attach — เปิด Chromium บน attack box ทาง SSH, ทำ port-forward เฉพาะ loopback ไปยัง CDP, แล้ว `connectOverCDP()`; **ล้าง `Singleton*` lock ก่อนเปิด** (บั๊กที่ 4) |
| `backend/src/services/browser-agent.service.ts` | แยก `startRemoteAgent()` / `startLocalAgent()`; `BrowserLaunchOptions`; fingerprint ของโหมด remote ไม่รวม LLM; **`stop()` ฆ่า Chromium บน attack box จริง** (บั๊กที่ 3) |
| `backend/src/services/burp-ca.service.ts` | profile dir ชี้ `/kali-data/chromium-home`; ที่อยู่ proxy เลือกจาก `BURP_*` ก่อน `MAGNITUDE_*` |
| `backend/scripts/browser-remote-check.ts` **(ใหม่)** | 11 การตรวจ พิสูจน์ทั้งสาย SSH → Chromium → tunnel → CDP → Playwright → DOM และยืนยันว่า process หายจริงหลัง stop (มี check ที่ 12 ในสคริปต์เป็นเส้นทางล้มเหลว) |
| `backend/tests/browserAgentService.test.ts` | + เทสต์โหมด remote (headful บังคับ, rewrite proxy, fingerprint, display, รูปแบบคำสั่ง launch, **stop ต้องฆ่า process**, **ต้องล้าง profile lock**) — พิสูจน์แล้วว่าทั้งคู่ fail เมื่อถอด fix |
| `kali/Dockerfile` | Layer 7 `apti chromium` — แยกชั้นล่างสุดเพื่อไม่ให้ invalidate ชั้น kali-linux-* ที่แพงที่สุด |
| `backend/.env.template`, `docker-compose.kali.yml`, `docker-compose.dev.yml` | `BROWSER_AGENT_REMOTE` / `_CDP_PORT` / `_PROFILE_DIR` / `_DISPLAY` |
| `docs/EGRESS-FENCE.md`, `docs/SETUP.md` | fence ครอบเบราว์เซอร์แล้ว / P0 VPN เป็น "Handled by design" |

รอบที่ 3 — settle / ยืนยันผลหลัง action / Burp CA (§3.10, §3.11):

| ไฟล์ | แก้อะไร |
|---|---|
| `backend/src/services/dom-browser.service.ts` | `settlePage()` (network idle + MutationObserver quiet window, มีขอบเขต) + `verifyAction()` (อ่านค่ากลับ / เทียบ fingerprint ของหน้า) + `pageRevision()`; **แก้ shim `__name` ให้ติดตั้งใหม่ทุกครั้ง** แทนการจำด้วย WeakSet (§3.11) |
| `backend/scripts/browser-dom-check.ts` | + 4 การตรวจของ settle/verify (รวมหน้าที่ paint ช้า, click ที่ไม่มีผล, field ที่ไม่เก็บค่า) |
| `backend/scripts/burp-ca-check.ts` **(ใหม่)** | 6 การตรวจ: CA ดึง+ติดตั้งได้ → `cert9.db` อยู่ใน NSS store ของเบราว์เซอร์ → CA อยู่ใน db → status ตรง → **Chromium บน attack box โหลด HTTPS ผ่าน Burp ได้จริง** → **issuer ของใบรับรองคือ PortSwigger** (ปิด cache + ต่อ query กัน cache) |
| `backend/src/services/remote-browser.service.ts` | `proxyUrlForAttackBox()` ประกอบ `scheme://[user:pass@]host:port` เองแทน `url.href` เพราะ `href` ต่อ `/` ท้ายเสมอ → Chromium ได้ proxy list ว่าง → `ERR_NO_SUPPORTED_PROXIES` ทุก request (**บั๊กที่ 5**) |
| `backend/package.json` | `check:browser:ca` |

---

## 9. สถานะการนำไปใช้ — **แก้แล้ว: AI ใช้ browser agent ได้แล้ว**

> **อัปเดต (หลัง deploy):** อิมเมจ `projectz-backend` ถูก build ใหม่ + recreate
> `vulnpen-backend` เป็น **Up (healthy)** แล้ว และรัน `scripts/browser-dom-check.ts`
> **จากในอิมเมจที่ deploy จริง** ได้ `verdict: PASS (0 failed)` 15/15 (ตอนนั้น — ปัจจุบัน 20/20)
> โดยไม่มี vision model และไม่มี screenshot
> `/api/healthcheck` → `{"status":"ready","mongodb":"ready","redis":"ready"}`

### ก่อน deploy — ทำไมตอนนั้นยังใช้ไม่ได้

โค้ดที่แก้แล้วทำงานได้จริง (พิสูจน์ด้วยการรันในคอนเทนเนอร์จริง: PASS 15/15)
แต่ **backend ที่รันอยู่ตอนนั้นยังใช้โค้ดเวอร์ชันเก่า** ซึ่งเป็นสาเหตุที่ผู้ใช้ยังใช้ browser agent ไม่ได้

หลักฐานจากคอนเทนเนอร์ `vulnpen-backend` (ก่อน build ใหม่):

| สิ่งที่ตรวจ | ผล (ก่อน) | ผล (หลัง deploy) |
|---|---|---|
| `dist/tools/handlers/magnitude-browser.js` | มี `agent.act(` → **ยังใช้ vision loop** | `agent.act(` = **0** |
| `dist/` มี `dom-browser.service.js` ไหม | **ไม่มี** | **มี** |
| `snapshotPage` ใน handler | 0 ครั้ง | **2** ครั้ง |
| `probeBrowserProxy` ใน service | 0 ครั้ง | **2** ครั้ง |
| `BrowserAgentWedgedError` ใน service | 0 ครั้ง | **5** ครั้ง |
| `browser_action` ใน `dist/tools/names.js` | — | **มี** (tool ลงทะเบียนจริง) |

ก่อน deploy **เส้นทาง DOM ทั้งหมดเป็นงานใน working tree ที่ยังไม่ถูก commit และไม่เคยถูก build**
อิมเมจจึงยังรัน `agent.act` + Moondream ซึ่งต้องใช้โมเดลที่อ่านภาพได้
ขณะที่โมเดลที่ assign ไว้คือ `oc/muse-spark-1.3-contributor-free` (reasoning off)
— ถ้ามันไม่รองรับภาพ การกระทำทุกครั้งจะพังหรือค้าง ตรงกับอาการที่รายงาน

### สภาพแวดล้อมพร้อมแล้ว (ตรวจจากในคอนเทนเนอร์)

| องค์ประกอบ | สถานะ |
|---|---|
| `MAGNITUDE_ENABLED` | `true` |
| โมเดล Browser Agent | assign + verify แล้ว (`openai-compatible`, reasoning `off`) |
| proxy `http://kali:8080` | **reachable** — Burp รันอยู่ใน `vulnpen-kali` (`java burpsuite.jar`, listen `*:8080`, resolve เป็น 172.18.0.4) |
| Xvfb display `:99` | มี (`/tmp/.X11-unix/X99`) |
| Chromium | ~~ติดตั้งในอิมเมจ backend~~ → **ย้ายไปอิมเมจ kali แล้ว** (§4) |

> หมายเหตุวิธีการวัด: การทดสอบด้วย `(exec 3<>/dev/tcp/host/port)` ใน `sh` **ใช้ไม่ได้** เพราะ
> `/dev/tcp` เป็นฟีเจอร์ของ bash — ครั้งแรกที่วัดจึงได้ผลผิดว่า "kali:8080 unreachable"
> ต้องวัดด้วย Node (`net.Socket`) ซึ่งเป็นกลไกเดียวกับ `probeBrowserProxy` จริง ๆ

### สิ่งที่ต้องทำเพื่อให้ใช้ได้ — **ทำแล้ว**

ต้อง **build อิมเมจ backend ใหม่แล้ว restart** (`Dockerfile` ทำ `COPY . .` แล้ว `pnpm run build`)

⚠️ **ข้อควรระวังก่อนสั่ง build:** working tree ปัจจุบันมีงานที่ยังไม่ commit จำนวนมาก
(`src/server.ts`, `src/controllers/auth.controller.ts`, การลบ `task.controller.ts` /
`task.routes.ts` / `ServiceTask.model.ts`, `package.json`, `pnpm-lock.yaml`,
`Sessions.model.ts`, `MulterMiddleware.ts`, …) การ build จะ **เอางานทั้งหมดนั้นขึ้น production
ไปด้วยพร้อมกัน** ไม่ใช่แค่การแก้ browser agent จึงควรตัดสินใจก่อนว่าจะ commit เฉพาะส่วนไหน

**สิ่งที่เกิดขึ้นจริง:** ผู้ใช้เลือกทาง **B** — build ทั้ง working tree
(`docker compose -f docker-compose.yml -f docker-compose.dev.yml build backend` แล้ว recreate)
ผลคือ WIP ทั้งหมดข้างต้นถูก ship ขึ้น production ไปพร้อมกัน
→ **ควร commit / ตรวจ `git diff` ให้เรียบร้อย เพื่อไม่ให้สถานะ production กับ git ต่างกันถาวร**

> หมายเหตุการอ่านค่า config: แอปอ่าน `.env` ผ่าน dotenv จาก **`/srv/data/.env`**
> (mount จาก `./backend/.env`) **ไม่ใช่** container environment
> — `docker exec vulnpen-backend env` จะ **ไม่เห็น** `MAGNITUDE_*` ให้อ่านจากไฟล์แทน
> และแอปฟังที่พอร์ต **8080** (ไม่ใช่ 3001)

### รอบที่ 2 — หลังย้ายเบราว์เซอร์ไป attack box (§4)

อิมเมจ `projectz-backend` และ `vulnpen-kali-fixed` ถูก build ใหม่ทั้งคู่ แล้ว recreate
`vulnpen-backend` / `vulnpen-kali` เป็น **Up (healthy)** ตรวจจาก **ในอิมเมจที่ deploy จริง**:

| สิ่งที่ตรวจ | ผล |
|---|---|
| `src/services/remote-browser.service.ts` อยู่ในอิมเมจ backend | **มี** |
| Chromium ในอิมเมจ backend | **ไม่มี** — `command -v chromium` → ไม่เจอ (ถูกต้อง: เบราว์เซอร์ไม่อยู่ที่นี่แล้ว) |
| Chromium ในอิมเมจ kali ที่ recreate ใหม่ | **มี** — `chromium --version` → `Chromium 150.0.7871.181`, `dpkg -S /usr/bin/chromium` → `chromium: /usr/bin/chromium` |
| เดสก์ท็อปของ attack box หลัง recreate | Xvnc `:89` (5989) + noVNC (9020) ขึ้นครบ |
| `scripts/browser-remote-check.ts` | **`verdict: PASS (0 failed)` — 11/11** |

`dpkg -S` คือหลักฐานว่า Chromium มาจาก **ชั้น Layer 7 ใน Dockerfile จริง** ไม่ใช่การ
`apt install` ชั่วคราวระหว่างรัน — เพราะคอนเทนเนอร์เดิมถูกแทนที่ทั้งใบ
ไม่มีอะไรที่ติดตั้งด้วยมือเหลืออยู่

ผลการตรวจทั้ง 11 ข้อ:

```
ssh        root@kali:22      cdp port 9222      profile /kali-data/chromium-home
proxy      http://kali:8080 -> http://127.0.0.1:8080/
PASS  the browser is configured to run on the attack box
PASS  the attack box answers over SSH — SSH_OK
PASS  Chromium is running on the attack box — pid …
PASS  Chromium draws on the attack box's desktop display — :89
PASS  an SSH tunnel to the CDP port is open — 127.0.0.1:…
PASS  the CDP endpoint answers through the tunnel
PASS  Playwright attached over CDP
PASS  the page reads back as DOM — 2 elements
PASS  the DOM snapshot indexed the controls
PASS  a DOM fill + click reached the page — submitted:operator
PASS  the browser is gone from the attack box after stop — no process left
```

สองบรรทัดสุดท้ายคือผลของบั๊กที่ 3 และการ recreate attack box คือสิ่งที่เปิดโปงบั๊กที่ 4
(§4) — ทั้งสองอย่างเจอ *หลัง* ที่ทุกอย่างดูผ่านแล้ว ไม่ใช่ตอนอ่านโค้ด

**การพิสูจน์บั๊กที่ 4 ในอิมเมจที่ deploy จริง** — ไม่ได้แค่รอให้ lock ค้างเอง แต่ *ปลูก* lock
ที่ชี้ไปยัง host ที่ไม่มีอยู่จริงลงไปก่อน แล้วรันจากในอิมเมจ backend:

```
ln -sf "deadbeef1234-99999" /kali-data/chromium-home/profile/SingletonLock
→ browser-remote-check.ts จากในอิมเมจ → verdict: PASS (0 failed)  11/11
```

และข้อสังเกตที่ทำให้บั๊กนี้ร้ายกว่าที่คิด: หลังรันจบ lock **ยังอยู่**
(`SingletonLock -> <hostname ปัจจุบัน>-<pid>`) เพราะ Chromium ไม่ล้าง lock ให้เมื่อถูก
`pkill` — แปลว่า lock ค้างเป็น**เส้นทางปกติของการหยุดทุกครั้ง** ไม่ใช่เคสของ crash
สิ่งที่กันไม่ให้มันกัดทันทีคือ hostname บังเอิญยังเหมือนเดิม จนกว่าจะ recreate container
นั่นคือเหตุผลที่ต้องล้าง lock ทุกครั้งตอน launch ไม่ใช่แค่ตอนกู้จาก crash

**ยังเหลือ (ไม่กระทบการใช้งาน):** อิมเมจ backend ยังรัน `patchright install chromium`
อยู่ (ราว 280 MiB ของ Chrome for Testing) ซึ่งจำเป็นเฉพาะโหมด local fallback
`BROWSER_AGENT_REMOTE=false` — ถ้าเลิกใช้โหมดนั้นเมื่อไร ตัดออกได้เลย
(ยังใช้อยู่จริง: `scripts/browser-dom-check.ts` รันบน Chromium ตัวนี้ใน backend)

### รอบที่ 3 — settle / ยืนยันผล / Burp CA (§3.10, §3.11)

อิมเมจ backend ถูก build ใหม่จาก working tree แล้ว recreate เป็น **Up (healthy)**
รัน **ทั้งสามชุดตรวจจากในอิมเมจที่ deploy จริง**:

| ชุดตรวจ | ขอบเขต | ผล |
|---|---|---|
| `check:browser` | DOM path + settle + ยืนยันผลหลัง action | **PASS (0 failed)** — 20 ข้อ |
| `check:browser:remote` | ทั้งสาย SSH → Chromium → tunnel → CDP → DOM | **PASS (0 failed)** — 11 ข้อ |
| `check:browser:ca` | Burp CA → NSS store ของเบราว์เซอร์บน attack box → โหลด HTTPS จริง | **PASS (0 failed)** — 6 ข้อ |
| เทสต์เต็ม | `tsx --test tests/*.test.ts` | **441 tests / 436 pass / 0 fail / 5 skipped** |
| `tsc --noEmit` / eslint | | สะอาด |

**สามข้อที่เคยค้างไว้ ตอนนี้ปิดแล้ว:**

1. **Burp CA → เบราว์เซอร์บน attack box** — ยืนยันครบสาย ไม่ใช่แค่ "ไฟล์อยู่":
   CA ถูกดึงจาก Burp (`CN=PortSwigger CA`) → เขียนลง `/kali-data/chromium-home/.pki/nssdb`
   ด้วย `certutil` **จากฝั่ง backend** → `cert9.db` ถูกสร้าง, CA ปรากฏใน db ด้วย trust `C,,`
   → และ **Chromium บน attack box โหลด `https://example.com/` ผ่าน Burp ได้จริง**
   (`"Example Domain"`) ซึ่งแปลว่าเบราว์เซอร์ยอมรับ leaf ที่ Burp เซ็น — ไม่ใช่แค่มีไฟล์อยู่
   ข้อสุดท้ายตรวจ **issuer ของใบรับรองที่ได้รับว่าเป็น PortSwigger** (ปิด cache แล้วต่อ query กัน cache)
   → ยืนยันว่า traffic ผ่าน Burp จริง ไม่ใช่ผ่านตรงหรือผ่าน cache

2. **settle wait + ยืนยันผลหลัง action** — §3.10 พร้อมหลักฐานย้อนกลับว่าถ้าถอดออกจะ fail

3. **`ERR_NO_SUPPORTED_PROXIES`** — **อธิบายได้แล้ว = บั๊กที่ 5** (ค่า proxy มี trailing slash)
   ไม่ใช่ความบังเอิญ: reproduce ได้ 3/3 เมื่อล้าง `chromium-home` และหายทันทีเมื่อตัด `/` ออก
   ⇒ ปิด

**ยังไม่ได้ทำ / ควรรู้:**
- `magnitude-core` ยังเป็น dependency (โหมด local fallback)

---

### รอบที่ 4 — panel "Browser Agent" ชี้ไปจอที่เบราว์เซอร์อยู่จริง + บั๊ก deploy 2 ตัวที่เจอระหว่างทาง

**อาการที่ผู้ใช้แจ้ง:** ใช้ browser agent แล้ว *ไม่เห็น* ว่ามันทำอะไร — panel เปิด ๆ ปิด ๆ
(แก้ไปแล้วรอบก่อน) แต่พอเปิดค้างได้ก็ยัง **เห็นจอว่าง ไม่เห็นการคลิก/เลื่อน**

**สาเหตุ:** มี VNC stack สองชุดคนละเครื่อง และ panel ฝังผิดชุด

| | display | RFB | noVNC | ใครอยู่บนจอนั้น |
|---|---|---|---|---|
| backend | `:99` | 5999 | **6080** | Chromium ตัว placeholder บน `about:blank` |
| attack box | `:89` | 5989 | **9020** | **เบราว์เซอร์ของ agent** + Xfce + Burp |

`BrowserAgentPanel` สร้าง URL เองแบบ `backendOrigin.hostname:novncPort` โดยที่ `novncPort`
มาจาก `getBrowserAgentNovncPort()` = 6080 เสมอ ⇒ สตรีมจอ placeholder ของ backend
ในขณะที่ agent คลิกอยู่บน `:89` ของ attack box (แท็บ Desktop ใช้เส้นทาง `resolveSessionWorkHost()`
จึงชี้ถูกอยู่แล้ว — panel กับ Desktop จึงดูคนละจอ)

**แก้:** ตัดสินใจฝั่ง API ไม่ใช่ฝั่ง UI — `services/browser-view.service.ts` (ใหม่) เป็นเจ้าของคำตอบ

- `remoteBrowserEnabled()` → `workHost: "attack-box"`, `display: ":89"`, `novncUrl: "http://localhost:9020"`,
  `password` (จาก `getVncConfig()` ตัวเดียวกับที่แท็บ Desktop ใช้), `browserRunning` (มี Chromium บนจอนั้นไหม)
- ไม่งั้น → stack ของ backend เองเหมือนเดิม (`novncUrl` ว่าง = ให้ UI ต่อ host จาก origin ของ backend)
- probe attack box ด้วย SSH **ครั้งเดียว** ต่อการเรียก 1 ครั้ง และ **ข้าม probe** เมื่อยังไม่มีอะไรจะสตรีม
  (`MAGNITUDE_ENABLED=false` หรือ headless ที่เป็น local) — endpoint นี้ถูก poll
- attack box ตอบไม่ได้ → **รายงาน** ไม่ถอยไปใช้จอ backend (จอนั้นมีจริงและเสิร์ฟได้ ⇒ จะดูเหมือนสำเร็จทั้งที่โชว์จอผิด)
- `available` คิดจาก `remote || !headless` เพราะบน attack box Chromium headful เสมอ (`buildBrowserAgentConfig`)
  ⇒ เดิมจะขึ้น "Headless mode is active" ทั้งที่ตั้งค่าไม่ใช่สาเหตุ
- UI: `utils/novncView.mjs` (ใหม่) รวมกฎสร้าง URL ไว้ที่เดียว ใช้ทั้ง panel และ DesktopPage
  ⇒ สองจอชี้ที่เดียวกันไม่ได้อีก และ**ใส่รหัสผ่านใน iframe เสมอ** เพราะ Xvnc รันด้วย `-rfbauth`

**หลักฐาน:**

| สิ่งที่วัด | ผล |
|---|---|
| Xvnc บน attack box | `:89 -rfbauth /root/.vnc/passwd`, websockify `:9020` |
| security types ที่ RFB เสนอ | `[2, 16]` ⇒ ต้องมีรหัสผ่าน |
| รหัสผ่านใน `backend/.env` | handshake จริงผ่าน DES challenge-response → **auth result 0 (accepted)** |
| client พร้อมกัน 2 ตัว (panel + แท็บ Desktop) | ต่อได้ทั้งคู่ ไม่ตัดกัน (จอ 1280x800) |
| `resolveBrowserView()` จากในคอนเทนเนอร์ที่ deploy จริง | `workHost=attack-box display=:89 novncUrl=http://localhost:9020 running=true` |
| หลังสั่ง launch Chromium บน `:89` | `browserRunning=true` และ screenshot ของ `:89` เห็น **Chromium + Burp** |
| เทสต์ใหม่ | `tests/browserViewTarget.test.ts` 20 ข้อ, `novncView.test.mjs` 10 ข้อ |

#### บั๊ก deploy 2 ตัวที่เจอเพราะรอบนี้ (ไม่ได้ตั้งใจหา)

ทั้งคู่มาจากคอมมิต `c9c4fbf` (ย้ายเบราว์เซอร์ไป attack box) และ **ทำให้ browser agent ใช้ไม่ได้เลย**
ในโหมด `docker-compose.kali.yml` — เป็นคำตอบจริงของอาการ "AI ใช้ Browser Agent ไม่ได้เลย"
ที่รายงานมาตั้งแต่ต้น ไม่ใช่เรื่องโมเดล:

1. **backend ไม่มี `SSH_HOST`/`SSH_PORT`** — `docker-compose.dev.yml` ตั้ง `SSH_HOST: kali`, `SSH_PORT: "22"`
   แต่ `docker-compose.kali.yml` ไม่ตั้ง ⇒ `buildSSHConfig()` ตกไปใช้ค่าจาก `.env` ที่เป็น
   *ฝั่ง host* (`localhost:4242`) ซึ่งในคอนเทนเนอร์คือ loopback ของตัวเอง ⇒ `ECONNREFUSED 127.0.0.1:4242`
   ทุกฟีเจอร์ที่พึ่ง SSH ตายหมด (launch เบราว์เซอร์, คำสั่ง agent บน attack box, provision desktop)
   วัด: ในคอนเทนเนอร์ `kali:22` = OPEN, `localhost:4242` = ECONNREFUSED

2. **`cap_drop: ALL` บน kali ทำให้กล่อง boot ไม่ขึ้น** (อยู่ในไฟล์ตั้งแต่ `70604a2` แต่คอนเทนเนอร์ที่รันอยู่
   ถูกสร้างก่อนหน้านั้น จึงเพิ่งมาเจอตอน recreate) — entrypoint รันด้วย `set -e` จึงไม่ใช่ "ลดสิทธิ์"
   แต่คือ restart-loop วัดทีละตัวกับอิมเมจจริง:

   | cap | ถ้าไม่มี จะเกิดอะไร |
   |---|---|
   | `CHOWN` | `chpasswd` ล้ม: `pam_chauthtok() failed` → คอนเทนเนอร์ออกก่อน sshd เริ่ม |
   | `SYS_CHROOT` | `chroot("/run/sshd"): Operation not permitted` → sshd privsep child ตาย ⇒ connection ถูก reset ทันทีหลัง TCP handshake (`Connection lost before handshake`) |
   | `SETGID` + `SETUID` | `setgroups: Operation not permitted` → privsep child exit 255 |

   `NET_BIND_SERVICE` / `NET_ADMIN` / `NET_RAW` เดิมยังจำเป็นเหมือนเดิม — สี่ตัวที่เพิ่มคือสิ่งที่
   OpenSSH กับ shadow-utils **ต้องมีจึงจะทำงานได้** ไม่ใช่สิทธิ์ที่เครื่องมือของ agent ต้องใช้

**หลักฐานหลังแก้:** `check:browser:remote` **PASS 11/11 จากในคอนเทนเนอร์** (เดิมทำไม่ได้เพราะ SSH ไม่ผ่าน)
— ครอบทั้งสาย SSH → Chromium บน `:89` → tunnel → CDP → DOM → fill+click → kill จนไม่เหลือ process

**กับดักที่เจอ (เขียนไว้กันพลาดซ้ำ):**
- `docker exec` ที่อ่าน script จาก heredoc ต้องมี `-i` ไม่งั้น `python3 -` อ่านได้ EOF แล้วออกเงียบ ๆ exit 0
- `docker exec ... ls /path` บน Git Bash ถูกแปลง path เป็น `C:/...` ⇒ ต้อง `MSYS_NO_PATHCONV=1`
- เรียก service ที่อ่าน env ตรง ๆ ด้วย `node -e` จะได้ env ไม่ครบ (`loadConfig()` ไม่ถูกเรียก)
  ⇒ ต้อง `require("./dist/utils/loadConfig.js").loadConfig()` ก่อน ไม่งั้นจะเห็น "auth failed" หลอก ๆ
- รัน `docker compose up -d` เองโดยไม่ส่ง `EGRESS_ALLOWLIST` ⇒ egress fence ไม่ยอมสตาร์ท
  (`assertEgressProxyArmed`) แล้ว **kali/backend/frontend ไม่ขึ้นตาม** เพราะ `depends_on: service_healthy`


### รอบที่ 5 — click ที่สำเร็จถูกรายงานเป็น "Browser action failed" + ข้อความชี้ไปที่ proxy ผิดที่

**อาการที่รายงานมา:**
```
Browser action failed: locator.click: Timeout 15000ms exceeded.
  - click action done
  - waiting for scheduled navigations to finish
```
คือ AI กดปุ่มสำเร็จ แต่ระบบบอกว่าล้มเหลว **และ** ต่อท้ายด้วยคำแนะนำให้ไปตรวจ proxy/VPN
ทั้งที่หน้าเว็บถูกเข้าถึงแล้วและฟอร์มก็ถูกส่งไปแล้ว

**กลไก (ยืนยันจากซอร์สของไดรเวอร์):** `patchright-core/lib/server/dom.js:413-414` —
หลัง dispatch event เสร็จ ไดรเวอร์จะ log `action done` แล้ว **รอ navigation ที่ action นั้นสั่งให้เกิดขึ้น**
(`waitForSignalsCreatedBy`) ถ้าเซิร์ฟเวอร์รับ connection แล้วไม่ตอบ navigation จะไม่ commit
⇒ `locator.click()` reject ด้วย timeout **ทั้งที่ event ถูกส่งไปแล้ว**

สองความผิดที่ตามมา:
1. รายงานว่า "action failed" ⇒ AI เข้าใจว่ายังไม่ได้กด แล้ว **กดซ้ำ** ซึ่งบนฟอร์มคือการ submit สองครั้ง
2. `browserReachabilityHint` เดิมแมตช์ `Timeout .* exceeded` แบบกว้าง ⇒ ข้อความบอกให้ไปตรวจ
   proxy/VPN ซึ่ง **ไม่ใช่สาเหตุ** (หน้าเว็บตอบแล้ว)

#### สิ่งที่วัดได้ และเปลี่ยนวิธีแก้

การวัดกับ attack box จริง (ฟอร์มที่ post ไปพอร์ตที่ accept แล้วเงียบ) พลิกสมมติฐานตอนแรก:

| การทดลอง | ผลที่วัดได้ |
|---|---|
| `locator.click()` (รอ navigation ตามค่าเริ่มต้น) | timeout 5s — **แต่ event ถูกส่งไปแล้ว** |
| หลัง timeout แล้วอ่านหน้าเว็บ | `title()` / `evaluate()` / `snapshotPage` **ค้างทั้งหมด** — `url()` ตอบได้ตัวเดียว (ไม่ต้องใช้ execution context) |
| ทางเลือก `noWaitAfter: true` | click กลับใน 304ms **แต่หน้าค้างถาวร** ⇒ ทางนี้แย่กว่า ไม่ใช้ |
| กู้ด้วย CDP `Page.stopLoading` | **~99ms และเอกสารเดิมยังอยู่** (DOM ที่ agent กำลังทำอยู่ไม่หาย) |
| กู้ด้วย `page.goto()` url เดิม | ~154ms แต่ **ทิ้งหน้าเดิม** |
| กู้ด้วย `page.reload()` | กู้ได้แต่โดยบังเอิญจากการ abort ของตัวเอง และรายงาน `net::ERR_ABORTED` |

ข้อสรุปสำคัญ: **ตัวที่ทำให้หน้าค้างคือ navigation ที่ค้างอยู่ ไม่ใช่ barrier ของ Playwright** —
ถ้าแก้แค่ข้อความ ระบบจะรายงานถูกแล้ว **แต่วิ่งต่อไม่ได้** (การอ่านหน้าถัดไปค้าง)
ดังนั้นการแก้ต้อง "กู้หน้า" ด้วย ไม่ใช่แค่เปลี่ยนข้อความ

#### สิ่งที่แก้

1. **`isPostActionNavigationTimeout()`** (`utils/magnitudeError.ts`) — ตัวแยกที่แคบโดยตั้งใจ:
   ต้องมีทั้ง `action done` **และ** `scheduled navigations` ⇒ timeout ที่หา element ไม่เจอ
   (ยังไม่ถึง `action done`) ยัง throw ต่อตามเดิม ถ้า Playwright เปลี่ยนข้อความในอนาคต
   ฟังก์ชันนี้คืน `false` = กลับไปพฤติกรรมเดิม ซึ่งเป็นทางที่ปลอดภัย
2. **`runDomAction`** — ถ้าเข้าเงื่อนไข: **ไม่เรียก `settlePage`** (มันคือการรอที่เพิ่งล้มเหลวไปแล้ว
   วัดได้ว่าเสียเวลาเป็นสิบวินาที) → `stopStuckLoading()` → คืนบรรทัดที่บอกว่าถูกส่งไปแล้ว
   พร้อมบอก url จริงของหน้า และ **ห้ามกดซ้ำ** ไม่เรียก `verifyAction` เพราะคำตัดสิน
   "หน้าไม่เปลี่ยน" จะทำให้เข้าใจผิด ทั้งที่รู้สาเหตุอยู่แล้ว
3. **`stopStuckLoading()`** — CDP `Page.stopLoading` ผ่าน session ชั่วคราว เป็น best-effort:
   ถ้าเปิด session ไม่ได้ หน้าจะแย่กว่าเดิมไม่ได้ และรายงานก็ยังจริงอยู่ดี
4. **`browserReachabilityHint()`** — แคบลงสองชั้น: (ก) ไม่ยิงเมื่อเป็น post-action navigation timeout
   (ข) ตัด `net::ERR_` แบบเหวี่ยงออก ใช้ **รายชื่อโค้ดที่แปลว่าติดต่อไม่ได้จริง ๆ** เท่านั้น
   เพราะ Chromium โยน `ERR_*` ให้เรื่องที่ไม่เกี่ยวกับการเข้าถึงด้วย (`ERR_UNSAFE_PORT`,
   `ERR_BLOCKED_BY_CLIENT`, `ERR_INVALID_URL`, `ERR_ABORTED`) — ซึ่งไปเก็บคำแนะนำ proxy/VPN ไปด้วย
   ส่วน timeout ธรรมดาต้องเป็น **timeout ของ navigation** (`navigating to`, `waiting until "..."`)
   ไม่ใช่ `Timeout Nms exceeded` ลอย ๆ
5. **`executeOnPage`** — การอ่านหน้าหลัง action ล้มได้โดยไม่ทำให้ action ล้ม (mid-navigation อ่านไม่ได้)
   ⇒ ถ้าอ่านไม่ได้ รายงานว่าอ่านไม่ได้ ไม่ใช่ "Browser action failed"

#### หลักฐาน

| สิ่งที่วัด | ผล |
|---|---|
| `npm run check:browser:hung` (จากในคอนเทนเนอร์ที่ deploy จริง) | **PASS 14/14** |
| ตัวคุม (positive control) ในเช็ค | raw click ค้างจริงตามที่รายงานมา ⇒ fixture reproduce ได้จริง ไม่ใช่สมมติ |
| ข้อความที่ AI เห็นตอนนี้ | `click was delivered, but the page is still http://127.0.0.1:8098/, so the navigation never committed within 5000ms. The load it started has been cancelled so the page can be read again — the address did answer, so this is not a routing problem ... Do not repeat the action` |
| หน้าหลัง action (เส้นทาง production) | อ่านได้ทันที (ก่อนแก้ = ค้างถาวร) |
| ที่อยู่ที่ติดต่อไม่ได้จริง (`127.0.0.1:8123`) | ยัง error + **ยังได้ hint** ⇒ ไม่ได้แก้ด้วยการปิด hint ทิ้ง |
| `ERR_UNSAFE_PORT` / `ERR_BLOCKED_BY_CLIENT` / `ERR_ABORTED` | **ไม่ได้** hint แล้ว (เดิมได้) |
| เทสต์ backend ทั้งชุด | **470 ข้อ / ผ่าน 465 / fail 0 / skip 5** (เดิม 461) |
| `tsc --noEmit` + eslint | สะอาด |

**กับดักที่เจอในรอบนี้:**
- `pkill -f 'hung-nav-fixture'` ในบรรทัดเดียวกับ `/tmp/hung-nav-fixture.py` ⇒ **ฆ่า shell ตัวเอง**
  ก่อนถึงคำสั่ง launch (bracket trick ไม่ช่วยเพราะชื่อไฟล์อยู่บรรทัดเดียวกัน) ต้องแยกเป็นคนละ SSH command
- สั่ง process เบื้องหลังผ่าน SSH ต้องมีทั้ง `setsid` **และ** `</dev/null` ไม่งั้น sshd เก็บกวาดตอน session ปิด
  (อาการ: log ว่างเปล่า ไม่มี error ให้เห็น)
- `docker exec -d` เพื่อรันเช็คยาว ๆ แทนการรอใน foreground — foreground แล้ว shell ฝั่ง host ถูก SIGTERM
  ระหว่างทาง ทำให้เข้าใจผิดว่าสคริปต์ค้าง ทั้งที่ฝั่งคอนเทนเนอร์รันต่ออยู่
- รันเช็คซ้อนกันสองตัวพร้อมกันจะแย่ง fixture + พอร์ต และ `launchRemoteChromium` ของตัวหลัง
  จะฆ่า Chromium ของตัวหน้า ⇒ ต้องเก็บกวาด process ค้างก่อนรันเสมอ

### รอบที่ 6 — panel "Browser Agent" ไม่ขึ้นจอ (iframe ว่าง) — attack box publish port ไม่ได้เลย

**อาการที่ผู้ใช้รายงาน:** "ไม่เห็นจอ ไม่ขึ้น"

**สาเหตุราก — ไม่ใช่การตั้งค่าผิด แต่เป็นข้อจำกัดของดีไซน์:**
`vulnpen-kali` ต่ออยู่กับเน็ตเวิร์ก **`control` และ `fenced` เท่านั้น ซึ่ง `internal: true` ทั้งคู่**
Docker **ไม่ apply port mapping** ให้คอนเทนเนอร์ที่ host ไม่มีเส้นทางเข้าไป — และมันเงียบด้วย:

| ตรวจ | ผล |
|---|---|
| `docker-compose.kali.yml` | ประกาศ `127.0.0.1:9020:9020` ไว้ |
| `HostConfig.PortBindings` | มีครบ (`9020/tcp → 127.0.0.1:9020`) |
| `NetworkSettings.Ports` (ค่าจริง) | **`{"9020/tcp":[]}`** — ว่าง |
| `docker port vulnpen-kali` | พิมพ์อะไรไม่ออกเลย |
| `curl http://127.0.0.1:9020/vnc.html` (จาก host) | **ต่อไม่ได้** (ไม่มีอะไรฟัง) |

⇒ panel สร้าง iframe เป็น `http://localhost:9020` ซึ่งบน host **ไม่มีอะไรอยู่** ⇒ จอว่าง
เทียบ: `vulnpen-backend` อยู่บน `default` (`internal: false`) ด้วย จึง publish ได้ปกติ

**แก้:** ให้ backend เป็นคน bridge จอของ attack box
1. `backend/entrypoint.sh` — เพิ่ม websockify ตัวที่สอง `:$BROWSER_AGENT_DESKTOP_PORT → $BROWSER_AGENT_DESKTOP_TARGET`
   (`9021 → kali:5989`) พร้อม watchdog + backoff + shutdown เหมือนตัวอื่น
   ตั้งใจให้ **เป็นอิสระจาก Xvfb ของ backend** และเช็กเป็นอันแรกในลูป เพราะบล็อก Xvfb จบด้วย `continue`
   ⇒ ถ้า display ของ backend ล่ม จะไม่ลากการดูแลจอของ attack box ไปด้วย
2. `docker-compose.kali.yml` (backend) — publish `127.0.0.1:9021:9021` + ตั้ง env สองตัว
3. `browser-view.service.ts` — `operatorNovncUrl()` เลือก bridge ก่อน แล้วค่อย fallback
   พร้อม `operatorNovncPort()` ที่ต้องตรงกัน (ไม่ให้ fallback ของ panel ชี้คนละพอร์ต = บั๊กเดิมเวอร์ชันเงียบ)
   เงื่อนไขใช้ bridge เฉพาะเมื่อ host ที่ตั้งไว้ **ไม่ใช่** ที่อยู่ที่เบราว์เซอร์เปิดเองได้
   (`localhost`/loopback/alias ใน Docker) — ถ้าเป็น IP หรือ FQDN จริง (attack box ระยะไกล) ปล่อยผ่าน
4. `vnc.controller.ts` — แท็บ Desktop ใช้ helper ตัวเดียวกัน (เดิมก็คืน `localhost:9020` ⇒ พังเหมือนกัน)

**หลักฐาน (จาก host — เส้นทางที่ผู้ใช้เปิดจริง):** `npm run check:vnc:bridge 9021`

| ขั้น | ผล |
|---|---|
| `GET /vnc.html` ผ่านพอร์ตที่ publish | **HTTP 200, 15212 bytes** (เท่ากับ 6080 ที่ทำงานอยู่) |
| WebSocket upgrade | ผ่าน และต่อรอง subprotocol `binary` |
| RFB version handshake | X server ตอบ **`"RFB 003.008\n"`** ⇒ มี X server อยู่หลัง bridge จริง |
| security types | `[2, 16]` ⇒ ต้องมีรหัสผ่าน |
| **VNC authentication** | **security result 0 = รหัสผ่านใน URL ของ panel ถูกต้อง** |
| `getBrowserAgentVNC()` ในคอนเทนเนอร์ที่ deploy | `novncUrl:"http://localhost:9021"`, `novncPort:"9021"`, `workHost:"attack-box"`, `display:":89"`, `rfbUp:true`, `novncUp:true` |
| backend suite | **474 ข้อ / ผ่าน 469 / fail 0 / skip 5** (เดิม 470) |
| เทสต์ใหม่ | `browserViewTarget.test.ts` +4 (bridge ถูกใช้ / box ระยะไกลไม่ถูกส่งผ่าน bridge / base URL ชนะ / ไม่มี bridge ก็ยังใช้พอร์ตเดิม) |

**หมายเหตุความซื่อสัตย์:** `getVNCCredentials` (แท็บ Desktop) เรียกตรง ๆ ไม่ได้เพราะต้องมี session
ที่เป็นเจ้าของจริง (เอกสาร session ไม่มี `createdBy`) — ยืนยันได้แค่ว่ามันเรียก helper ตัวเดียวกับ
panel ที่เทสต์ไว้แล้ว; ผู้ใช้ควรกดดูแท็บ Desktop ยืนยันอีกครั้ง

**กับดักที่เจอ:**
- shell ของ agent มี `http_proxy=127.0.0.1:51730` ⇒ `curl http://localhost:9020` ได้ **502**
  ซึ่งอ่านเหมือน "มี proxy ที่ host" ทั้งที่จริงคือไม่มีอะไรฟัง ⇒ ต้อง `curl --noproxy '*'` จึงเห็นความจริง
- Node 22 (OpenSSL 3) ทำ DES-ECB ไม่ได้ถ้าไม่โหลด legacy provider
  (`error:0308010C:digital envelope routines::unsupported`) ⇒ ต้อง `NODE_OPTIONS=--openssl-legacy-provider`
  จึงคำนวณ VNC challenge-response ได้ — ไม่งั้นเช็ครหัสผ่านจะ SKIP เงียบ ๆ
- `docker compose up -d kali` **ไม่ recreate** เมื่อ compose ไม่เปลี่ยน (มันเทียบ config hash)
  ⇒ ต้อง `--force-recreate` เมื่ออยากให้ mapping มีผลจริง
