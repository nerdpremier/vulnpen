/**
 * Live check: can the OPERATOR's browser actually open the attack box's screen?
 *
 * The failure this exists to catch, and which shipped: the panel embedded
 * `http://localhost:9020` — the attack box's own noVNC port — and nothing on the
 * host was listening there. The attack box is attached to `control` and
 * `fenced`, both `internal: true`, and Docker does not apply a port mapping for
 * a container the host has no route into. It is silent about it, too: the
 * compose file declares the mapping, `HostConfig.PortBindings` carries it, and
 * `NetworkSettings.Ports` still comes back `{"9020/tcp":[]}` with `docker port`
 * printing nothing. Every check that looked at the *box* passed while the
 * operator saw a blank frame.
 *
 * So this walks the path the browser walks, and does not stop at HTTP 200 —
 * served web assets prove nothing about whether a screen is behind them:
 *
 *   1. GET /vnc.html             the noVNC app is served
 *   2. WebSocket upgrade         the bridge accepts one, and negotiates `binary`
 *   3. RFB version handshake     an X server answers through it
 *   4. VNC authentication        the password the panel passes is ACCEPTED
 *
 * (4) is the step that separates "the page loads" from "the operator sees
 * pixels": this Xvnc runs with `-rfbauth`, so a wrong password stops at
 * "Authentication required" with a perfectly healthy-looking page.
 *
 * Run from the HOST to prove the published path the operator uses — DES needs
 * OpenSSL's legacy provider, which Node does not load by default:
 *   NODE_OPTIONS=--openssl-legacy-provider npx tsx scripts/vnc-bridge-check.ts 9021
 * Or inside the backend container to prove the bridge itself.
 */
import net from "node:net";
import crypto from "node:crypto";
import { getVncConfig } from "../src/services/vnc-provisioning.service";
import { loadConfig } from "../src/utils/loadConfig";

const PORT = Number(process.argv[2] || process.env.BROWSER_AGENT_DESKTOP_PORT || 9021);
const HOST = process.env.VNC_BRIDGE_CHECK_HOST || "127.0.0.1";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};
const skip = (label: string, why: string): void => {
  console.log(`  SKIP  ${label} — ${why}`);
};

async function get(path: string): Promise<{ status: number; size: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    const chunks: Buffer[] = [];
    socket.setTimeout(8_000);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const status = Number(text.split(" ")[1] || 0);
      const body = text.slice(text.indexOf("\r\n\r\n") + 4);
      resolve({ status, size: body.length });
    });
  });
}

/**
 * Unwrap WebSocket binary frames into the RFB byte stream underneath.
 *
 * The two protocols nest: RFB bytes ride inside WS frames, and one read can
 * carry part of a frame or several. RFB is itself a stream, so the frames are
 * unwrapped into one buffer and read from there by length.
 */
class RfbStream {
  private frames = Buffer.alloc(0);
  private data = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.frames = Buffer.concat([this.frames, chunk]);
    for (;;) {
      if (this.frames.length < 2) return;
      const opcode = this.frames[0] & 0x0f;
      let length = this.frames[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.frames.length < 4) return;
        length = this.frames.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frames.length < 10) return;
        length = Number(this.frames.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (this.frames[1] & 0x80) !== 0;
      let mask: Buffer | null = null;
      if (masked) {
        if (this.frames.length < offset + 4) return;
        mask = this.frames.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.frames.length < offset + length) return;

      const payload = Buffer.from(this.frames.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.frames = this.frames.subarray(offset + length);
      if (opcode === 0x8) throw new Error("the bridge closed the connection");
      if (opcode === 0x2 || opcode === 0x1) this.data = Buffer.concat([this.data, payload]);
    }
  }

  async take(bytes: number): Promise<Buffer> {
    while (this.data.length < bytes) await new Promise((r) => setTimeout(r, 20));
    const out = this.data.subarray(0, bytes);
    this.data = this.data.subarray(bytes);
    return out;
  }
}

/** Client frames must be masked; websockify rejects unmasked ones. */
function wsFrame(payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const header =
    payload.length < 126
      ? Buffer.from([0x82, 0x80 | payload.length])
      : Buffer.concat([Buffer.from([0x82, 0x80 | 126]), (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(payload.length);
          return b;
        })()]);
  return Buffer.concat([header, mask, masked]);
}

/** VNC's DES key: each password byte bit-reversed, padded to eight bytes. */
function vncKey(password: string): Buffer {
  const raw = Buffer.from(password.slice(0, 8), "latin1");
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    let value = raw[i] ?? 0;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    key[i] = reversed;
  }
  return key;
}

function desEncrypt(challenge: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("des-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** The full RFB handshake, authentication included. */
async function rfbSession(password: string): Promise<void> {
  const socket = net.connect(PORT, HOST);
  const stream = new RfbStream();
  let opened = false;
  const timer = setTimeout(() => socket.destroy(new Error("timed out")), 15_000);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write(
          `GET /websockify HTTP/1.1\r\n` +
            `Host: ${HOST}:${PORT}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Protocol: binary\r\n\r\n",
        );
      });
      let handshake = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        if (opened) return stream.push(chunk);
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = handshake.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) {
          return reject(new Error(`refused the upgrade: ${head.split("\r\n")[0]}`));
        }
        // `base64` would put the RFB bytes in text; the parser below reads
        // binary, so the negotiation has to be confirmed rather than assumed.
        if (!/sec-websocket-protocol:\s*binary/i.test(head)) {
          return reject(new Error("the bridge did not negotiate the binary subprotocol"));
        }
        opened = true;
        socket.off("data", onData);
        socket.on("data", (next: Buffer) => stream.push(next));
        stream.push(handshake.subarray(end + 4));
        resolve();
      };
      socket.on("data", onData);
    });
    check("the bridge accepted a WebSocket upgrade", true, "binary subprotocol");

    // Version exchange: the client speaks first.
    socket.write(wsFrame(Buffer.from("RFB 003.008\n", "ascii")));
    const version = (await stream.take(12)).toString("ascii");
    check(
      "an X server answered through the bridge",
      /^RFB \d{3}\.\d{3}\n$/.test(version),
      JSON.stringify(version),
    );

    // Security: a count, then that many type bytes. 2 is VNC authentication.
    const count = (await stream.take(1))[0];
    const types = await stream.take(count);
    check(
      "the X server offers VNC authentication",
      types.includes(2),
      `types [${Array.from(types).join(", ")}]`,
    );

    socket.write(wsFrame(Buffer.from([2])));
    const challenge = await stream.take(16);

    let response: Buffer;
    try {
      response = desEncrypt(challenge, vncKey(password));
    } catch (error: any) {
      throw new Error(
        `DES is unavailable (${error?.message}). Re-run with ` +
          "NODE_OPTIONS=--openssl-legacy-provider.",
      );
    }
    socket.write(wsFrame(response));

    const result = await stream.take(4);
    const accepted = result.readUInt32BE(0) === 0;
    check(
      "the password in the panel's URL is ACCEPTED",
      accepted,
      accepted ? "security result 0" : `security result ${result.readUInt32BE(0)}`,
    );
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function main(): Promise<void> {
  loadConfig();
  const password = getVncConfig().password || "";

  console.log(`\n=== noVNC bridge check (${HOST}:${PORT}) ===`);
  console.log("  the address the operator's browser and the panel open\n");

  try {
    const page = await get("/vnc.html");
    check(
      "the noVNC app is served on the published port",
      page.status === 200 && page.size > 1_000,
      `HTTP ${page.status}, ${page.size} bytes`,
    );
  } catch (error: any) {
    check("the noVNC app is served on the published port", false, error?.message);
  }

  if (!password) {
    skip("the password in the panel's URL is ACCEPTED", "no VNC password configured");
  } else {
    try {
      await rfbSession(password);
    } catch (error: any) {
      if (/DES is unavailable/.test(error?.message ?? "")) {
        skip("the password in the panel's URL is ACCEPTED", error.message);
      } else {
        check("the RFB session completed", false, error?.message ?? String(error));
      }
    }
  }

  console.log(
    `\nverdict: ${failures.length ? `FAIL (${failures.length} failed)` : "PASS (0 failed)"}`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
