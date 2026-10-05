import { ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

import { stripAnsi as stripAnsiSequences } from "../utils/ansi";

export const RING_BUFFER_MAX = 256 * 1024; // 256KB per shell
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Wrap a command in a login shell so PATH additions from .zprofile/.bashrc
 * (brew, apt-installed tooling, language version managers) are available.
 *
 * $SHELL must not be used bare: it is routinely unset in containers and over
 * non-interactive SSH, and the wrapper then degrades to ` -l -c '…'`, so the
 * shell tries to execute "-l" as a program and every command fails with
 * "/bin/sh: 1: -l: not found". Fall back to bash, then sh, when it is empty.
 */
export function escapeForLoginShell(command: string): string {
  const escaped = command.replace(/'/g, "'\\''");
  return `"\${SHELL:-$(command -v bash || command -v sh)}" -l -c '${escaped}'`;
}

export function stripAnsi(output: string): string {
  // Same policy the tool-result path renders with: CSI plus OSC and charset
  // sequences, not just CSI, or shell captures disagree with what the model
  // and the chat show.
  return stripAnsiSequences(output);
}

/**
 * Bounded tail of a shell's output. Appends forever but keeps at most
 * `maxSize` chars; reads are async-offset based so reconnects can resume
 * from the last consumed position without replaying the whole buffer.
 */
export class RingBuffer {
  private buffer: string = "";
  private maxSize: number;
  private _offset: number = 0;

  constructor(maxSize: number = RING_BUFFER_MAX) {
    this.maxSize = maxSize;
  }

  append(data: string): void {
    this.buffer += data;
    if (this.buffer.length > this.maxSize) {
      const excess = this.buffer.length - this.maxSize;
      this.buffer = this.buffer.slice(excess);
      this._offset += excess;
    }
  }

  read(fromOffset?: number): { data: string; offset: number } {
    const start = fromOffset ?? this._offset;
    const relativeStart = Math.max(0, start - this._offset);
    return {
      data: this.buffer.slice(relativeStart),
      offset: this._offset + this.buffer.length,
    };
  }

  get currentOffset(): number {
    return this._offset + this.buffer.length;
  }

  get length(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = "";
    this._offset = 0;
  }
}

export interface RuntimeChannel extends EventEmitter {
  stderr?: EventEmitter;
  write(data: string): unknown;
  end(): unknown;
  destroy(): unknown;
  setWindow?(rows: number, cols: number, height: number, width: number): unknown;
}

export function localChannel(child: ChildProcessWithoutNullStreams): RuntimeChannel {
  const channel = child.stdout as unknown as RuntimeChannel;
  channel.stderr = child.stderr;
  channel.write = (data: string) => child.stdin.write(data);
  channel.end = () => child.stdin.end();
  channel.destroy = () => child.kill("SIGTERM");
  child.on("close", (code) => channel.emit("close", code));
  child.on("error", (error) => channel.emit("error", error));
  return channel;
}
