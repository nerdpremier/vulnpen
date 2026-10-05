import { test } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer, stripAnsi } from "../src/services/shell-io";

test("ring buffer keeps the tail within maxSize and tracks offset", () => {
  const buf = new RingBuffer(10);
  buf.append("0123456789");
  buf.append("abcdef");
  assert.equal(buf.length, 10);
  const { data, offset } = buf.read();
  assert.equal(data, "6789abcdef".slice(-10));
  assert.equal(offset, 16);
  assert.equal(buf.currentOffset, 16);
});

test("ring buffer resumes from a caller-held offset", () => {
  const buf = new RingBuffer(100);
  buf.append("hello ");
  const first = buf.read();
  buf.append("world");
  const second = buf.read(first.offset);
  assert.equal(second.data, "world");
});

test("a stale offset that fell off the front starts at the retained tail", () => {
  const buf = new RingBuffer(4);
  buf.append("xxxxxxxxxx"); // buffer now "xxxx" at offset 6
  const res = buf.read(0);
  assert.equal(res.data, "xxxx");
  assert.equal(res.offset, 10);
});

test("clear resets data and offset", () => {
  const buf = new RingBuffer(10);
  buf.append("abc");
  buf.clear();
  assert.equal(buf.length, 0);
  assert.equal(buf.currentOffset, 0);
  assert.equal(buf.read().data, "");
});

test("stripAnsi removes escape sequences and trims", () => {
  assert.equal(stripAnsi("\x1B[31mred\x1B[0m\n"), "red");
});
