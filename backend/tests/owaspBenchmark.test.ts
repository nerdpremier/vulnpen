import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { classifyWithLlm } from "../src/services/web-security/owasp-llm-classifier";
import { mapFindingToOwaspTop10 } from "../src/services/web-security/owasp-mapping.service";

interface BenchmarkItem {
  key: string;
  name: string;
  description: string;
  label: string;
  sourceCategory: string;
}

interface BenchmarkFixture {
  items: BenchmarkItem[];
}

const fixturePath = path.join(__dirname, "fixtures", "owaspBenchmark.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as BenchmarkFixture;
// LLM calls cost money and need a configured provider, so the benchmark only
// runs when explicitly requested (same pattern as the platform-dependent tests).
const llmEnabled = process.env.VULNPEN_BENCHMARK_LLM === "1";

test("benchmark fixture has valid labels for every challenge", () => {
  assert.ok(fixture.items.length >= 100, `expected >=100 items, got ${fixture.items.length}`);
  const valid = new Set(["A01:2025", "A02:2025", "A03:2025", "A04:2025", "A05:2025", "A06:2025", "A07:2025", "A08:2025", "A09:2025", "A10:2025"]);
  for (const item of fixture.items) {
    assert.ok(valid.has(item.label), `${item.key}: bad label ${item.label}`);
    assert.ok(item.name, item.key);
  }
});

test(
  "LLM classifier beats the old keyword layer's F1 on the challenge set",
  { skip: !llmEnabled },
  async () => {
    let truePositive = 0;
    let classified = 0;
    const correctByLabel = new Map<string, { correct: number; total: number }>();
    const misclassified: string[] = [];

    for (const item of fixture.items) {
      // The deterministic layers see no WSTG id and no single-candidate CWE in
      // this dataset, so the classifier layer is what is being measured.
      const deterministic = mapFindingToOwaspTop10({ title: item.name, description: item.description });
      const result = await classifyWithLlm(
        { title: item.name, description: item.description },
        { userId: process.env.VULNPEN_BENCHMARK_USER_ID ?? "benchmark" },
      );
      const predicted = result?.primary ?? deterministic.ambiguous?.[0];
      if (!predicted) continue;
      classified++;
      const stat = correctByLabel.get(item.label) ?? { correct: 0, total: 0 };
      stat.total++;
      if (predicted === item.label) {
        truePositive++;
        stat.correct++;
      } else {
        misclassified.push(`${item.name}: expected ${item.label}, got ${predicted}`);
      }
      correctByLabel.set(item.label, stat);
    }

    const precision = classified ? truePositive / classified : 0;
    const recall = truePositive / fixture.items.length;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    console.log(`n=${fixture.items.length} classified=${classified} P=${(precision * 100).toFixed(2)}% R=${(recall * 100).toFixed(2)}% F1=${(f1 * 100).toFixed(2)}%`);
    if (misclassified.length) {
      console.log("misclassified sample:\n" + misclassified.slice(0, 15).join("\n"));
    }
    // The removed keyword layer scored F1 44.66% on this kind of data.
    assert.ok(f1 >= 0.5, `F1 ${(f1 * 100).toFixed(2)}% below the 50% bar`);
  },
  { timeout: 900_000 },
);
