/**
 * Deterministic mapping of security findings to the OWASP Top 10:2025.
 *
 * The agent is asked to classify findings as it reports them, but models drift
 * and forget. This service gives the assistant (and the REST API, and the
 * report builder) one reproducible answer: an explicit tester mapping wins,
 * then the OWASP categories attached to the WSTG v4.2 test case that produced
 * the finding, then the CWE list OWASP publishes for each category, then a
 * keyword classifier. When nothing matches we return "unmapped" rather than
 * guessing, and the caller is told what to add to classify the finding.
 */

import {
  OWASP_TOP10_2025,
  getOwaspCategory,
  getWstgTest,
  normalizeOwaspTop10Id,
} from "../../knowledge";
import type { OwaspTop10Id } from "../../knowledge";

export type OwaspMappingSource =
  | "explicit"
  | "wstg"
  | "cwe"
  | "keyword"
  | "unmapped";

export type OwaspMappingConfidence = "high" | "medium" | "low";

export interface OwaspMappingInput {
  title?: string;
  description?: string;
  contextSummary?: string;
  evidence?: string;
  endpoint?: string;
  service?: string;
  tags?: string[];
  cwe?: string;
  wstgId?: string;
  /** An explicit classification already chosen by the tester or the agent. */
  owaspTop10?: string;
}

export interface OwaspMappingResult {
  primary?: OwaspTop10Id;
  primaryTitle?: string;
  related: OwaspTop10Id[];
  wstgIds: string[];
  confidence: OwaspMappingConfidence;
  source: OwaspMappingSource;
  rationale: string;
}

interface KeywordRule {
  pattern: RegExp;
  primary: OwaspTop10Id;
  related: OwaspTop10Id[];
  wstgIds: string[];
  label: string;
}

const CWE_INDEX: ReadonlyMap<string, OwaspTop10Id[]> = (() => {
  const index = new Map<string, OwaspTop10Id[]>();
  for (const category of OWASP_TOP10_2025) {
    for (const cwe of category.cwes) {
      const key = normalizeCwe(cwe);
      if (!key) continue;
      const current = index.get(key) ?? [];
      if (!current.includes(category.id)) current.push(category.id);
      index.set(key, current);
    }
  }
  return index;
})();

const KEYWORD_RULES: KeywordRule[] = [
  {
    pattern: /(sql|nosql|ldap|xpath|xxe|xml|ssti|template injection|command injection|os command|code injection|expression language|server-side includes|ssi injection|crlf injection|header injection|http request smuggling|http splitting|xss|cross site script|html injection|javascript injection|graphql injection)/i,
    primary: "A05:2025",
    related: ["A03:2025", "A04:2025"],
    wstgIds: ["WSTG-INPV-05", "WSTG-INPV-01", "WSTG-INPV-02", "WSTG-INPV-12"],
    label: "injection-class weakness",
  },
  {
    pattern: /(ssrf|server-side request forgery)/i,
    primary: "A01:2025",
    related: ["A05:2025"],
    wstgIds: ["WSTG-INPV-19"],
    label: "server-side request forgery (2025 folds SSRF into broken access control)",
  },
  {
    pattern: /(idor|insecure direct object|access control|authorization bypass|authorisation bypass|privilege escalation|forced browsing|missing function[- ]level|horizontal escalation|vertical escalation|tenant isolation|path traversal|directory traversal|local file inclusion|remote file inclusion)/i,
    primary: "A01:2025",
    related: ["A04:2025"],
    wstgIds: ["WSTG-ATHZ-04", "WSTG-ATHZ-02", "WSTG-ATHZ-03", "WSTG-ATHZ-01", "WSTG-INPV-11"],
    label: "access-control weakness",
  },
  {
    pattern: /(csrf|cross site request forgery)/i,
    primary: "A01:2025",
    related: ["A07:2025"],
    wstgIds: ["WSTG-SESS-05"],
    label: "request forgery handled by the broken access control category",
  },
  {
    pattern: /(open redirect|unvalidated redirect|url redirect)/i,
    primary: "A01:2025",
    related: ["A05:2025"],
    wstgIds: ["WSTG-CLNT-04"],
    label: "unvalidated redirect",
  },
  {
    pattern: /(cors|cross origin resource sharing|cross[- ]domain policy)/i,
    primary: "A02:2025",
    related: ["A01:2025"],
    wstgIds: ["WSTG-CLNT-07", "WSTG-CONF-08"],
    label: "cross-origin policy misconfiguration",
  },
  {
    pattern: /(default credential|default password|weak credential)/i,
    primary: "A02:2025",
    related: ["A07:2025"],
    wstgIds: ["WSTG-ATHN-02", "WSTG-CONF-02"],
    label: "default credentials left in place",
  },
  {
    pattern: /(misconfigur|directory listing|directory index|exposed admin|admin interface|debug endpoint|actuator|phpinfo|backup file|unreferenced file|unnecessary service|security header|http method|web server metafile|exposed \.git|cloud storage bucket)/i,
    primary: "A02:2025",
    related: ["A05:2025"],
    wstgIds: ["WSTG-CONF-02", "WSTG-CONF-04", "WSTG-CONF-05", "WSTG-CONF-06", "WSTG-CONF-11"],
    label: "security misconfiguration",
  },
  {
    pattern: /(clickjacking|frame[- ]?buster|x-frame-options)/i,
    primary: "A02:2025",
    related: ["A04:2025"],
    wstgIds: ["WSTG-CLNT-09"],
    label: "missing browser-hardening configuration",
  },
  {
    pattern: /(deserial|unsigned|unverified|integrity check|ci\/cd pipeline|supply chain|dependency confusion|typosquat|sbom|third[- ]party component|outdated (component|library|dependency)|vulnerable dependency|subdomain takeover)/i,
    primary: "A03:2025",
    related: ["A08:2025", "A02:2025"],
    wstgIds: ["WSTG-CONF-10", "WSTG-INFO-02", "WSTG-INFO-08"],
    label: "software supply chain weakness",
  },
  {
    pattern: /(tls|ssl|certificate|cipher suite|cleartext|unencrypted|weak hash|md5|sha-?1|hardcoded (secret|key|password)|encryption|padding oracle|weak crypto|hsts)/i,
    primary: "A04:2025",
    related: ["A02:2025"],
    wstgIds: ["WSTG-CRYP-01", "WSTG-CRYP-02", "WSTG-CRYP-03", "WSTG-CRYP-04", "WSTG-CONF-07"],
    label: "cryptographic failure",
  },
  {
    pattern: /(authentication|authorisation|authorization (schema|bypass)|login|credential stuffing|password (policy|reset|change|recovery|spray)|brute[- ]?force|lock[- ]?out|mfa|2fa|one[- ]?time password|otp|remember me|session fixation|session hijack|session puzzle|cookie attribute|account enumeration|account takeover|jwt|saml|oauth)/i,
    primary: "A07:2025",
    related: ["A01:2025"],
    wstgIds: ["WSTG-ATHN-01", "WSTG-ATHN-03", "WSTG-ATHN-04", "WSTG-ATHN-07", "WSTG-ATHN-09", "WSTG-IDNT-04", "WSTG-SESS-03"],
    label: "authentication or session-handling failure",
  },
  {
    pattern: /(identification|registration|provisioning|role definition|username policy|identity management)/i,
    primary: "A07:2025",
    related: ["A06:2025"],
    wstgIds: ["WSTG-IDNT-01", "WSTG-IDNT-02", "WSTG-IDNT-03", "WSTG-IDNT-05"],
    label: "identity-management weakness feeding authentication failures",
  },
  {
    pattern: /(insecure design|business logic|logic flaw|race condition|toctou|workflow (bypass|circumvention)|process timing|replay|anti[- ]automation|abuse|missing rate limit|number of times)/i,
    primary: "A06:2025",
    related: ["A01:2025"],
    wstgIds: ["WSTG-BUSL-01", "WSTG-BUSL-02", "WSTG-BUSL-04", "WSTG-BUSL-06", "WSTG-BUSL-07"],
    label: "insecure design or broken business logic",
  },
  {
    pattern: /(file upload|unrestricted upload|unexpected file type|malicious file|zip slip)/i,
    primary: "A05:2025",
    related: ["A08:2025", "A02:2025"],
    wstgIds: ["WSTG-BUSL-08", "WSTG-BUSL-09"],
    label: "upload handling that reaches code execution",
  },
  {
    pattern: /(logging|log injection|no audit|missing monitor|alerting|detection gap|siem)/i,
    primary: "A09:2025",
    related: ["A02:2025"],
    wstgIds: ["WSTG-ERRH-01", "WSTG-CONF-02"],
    label: "logging and alerting failure",
  },
  {
    pattern: /(stack trace|verbose error|error handling|improper error|unhandled exception|information disclosure|debug output|fail open|denial of service|crash|resource exhaustion|memory exhaustion|uncaught|unchecked return)/i,
    primary: "A10:2025",
    related: ["A09:2025", "A02:2025"],
    wstgIds: ["WSTG-ERRH-01", "WSTG-ERRH-02", "WSTG-INPV-13"],
    label: "mishandled exceptional condition",
  },
  {
    pattern: /(sensitive (data|information) (exposure|disclosure|leak)|information leakage|pii|cardholder|informative (comment|response)|metadata leak)/i,
    primary: "A04:2025",
    related: ["A01:2025", "A02:2025"],
    wstgIds: ["WSTG-INFO-05", "WSTG-INFO-03", "WSTG-ATHN-06"],
    label: "exposure of protected data",
  },
  {
    pattern: /(websocket|postmessage|web messaging|browser storage|localstorage|sessionstorage|dom-based|dom xss|source map|client-side (url|resource)|javascript execution|css injection|cross site script inclusion|flash)/i,
    primary: "A05:2025",
    related: ["A02:2025"],
    wstgIds: ["WSTG-CLNT-01", "WSTG-CLNT-02", "WSTG-CLNT-05", "WSTG-CLNT-06", "WSTG-CLNT-10", "WSTG-CLNT-11", "WSTG-CLNT-12", "WSTG-CLNT-13"],
    label: "client-side code execution",
  },
];

export function normalizeCwe(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toUpperCase();
  if (!raw) return "";
  if (/^CWE-\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `CWE-${raw}`;
  const bare = raw.match(/CWE[-_ ]?(\d+)/);
  return bare ? `CWE-${bare[1]}` : raw;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function byRank(ids: OwaspTop10Id[]): OwaspTop10Id[] {
  return unique(ids).sort((a, b) => a.localeCompare(b));
}

function primaryCategoryForLexicon(
  cwe: string,
): { primary: OwaspTop10Id; all: OwaspTop10Id[] } | undefined {
  const key = normalizeCwe(cwe);
  if (!key) return undefined;
  const categories = CWE_INDEX.get(key);
  if (!categories?.length) return undefined;
  return { primary: categories[0], all: categories };
}

function ruleMatches(haystack: string, rule: KeywordRule): boolean {
  return rule.pattern.test(haystack);
}

export function mapFindingToOwaspTop10(
  input: OwaspMappingInput,
): OwaspMappingResult {
  const wstg = getWstgTest(input.wstgId);
  const explicit = normalizeOwaspTop10Id(input.owaspTop10);

  if (explicit) {
    const category = getOwaspCategory(explicit)!;
    return {
      primary: explicit,
      primaryTitle: category.title,
      related: byRank(wstg?.owasp ?? []).filter((id) => id !== explicit),
      wstgIds: wstg ? [wstg.id] : [],
      confidence: "high",
      source: "explicit",
      rationale:
        `Classified as ${explicit} ${category.title} from the tester's explicit mapping` +
        (wstg ? ` on test case ${wstg.id} (${wstg.title})` : "") +
        ".",
    };
  }

  if (wstg) {
    const [primary, ...related] = wstg.owasp;
    const category = getOwaspCategory(primary)!;
    return {
      primary,
      primaryTitle: category.title,
      related: byRank(related),
      wstgIds: [wstg.id],
      confidence: "high",
      source: "wstg",
      rationale:
        `Test case ${wstg.id} (${wstg.title}) targets ${category.id} ${category.title}` +
        " per the OWASP Top 10:2025 mapping of WSTG v4.2.",
    };
  }

  const haystack = [
    input.title,
    input.description,
    input.contextSummary,
    input.evidence,
    input.endpoint,
    input.service,
    ...(input.tags ?? []),
  ]
    .filter(Boolean)
    .join(" \n ");

  const keywordRules = KEYWORD_RULES.filter((rule) => ruleMatches(haystack, rule));

  const lexicon = primaryCategoryForLexicon(input.cwe ?? "");
  if (lexicon) {
    const category = getOwaspCategory(lexicon.primary)!;
    const related = byRank([
      ...lexicon.all.filter((id) => id !== lexicon.primary),
      ...keywordRules.flatMap((rule) => [rule.primary, ...rule.related]),
    ]).filter((id) => id !== lexicon.primary);
    return {
      primary: lexicon.primary,
      primaryTitle: category.title,
      related,
      wstgIds: unique(keywordRules.flatMap((rule) => rule.wstgIds)),
      confidence: lexicon.all.length === 1 ? "high" : "medium",
      source: "cwe",
      rationale:
        `${normalizeCwe(input.cwe)} is listed by the OWASP Top 10:2025 under ` +
        `${lexicon.all.join(", ")}; the strongest fit is ${lexicon.primary} ${category.title}` +
        (keywordRules.length
          ? `, corroborated by ${keywordRules.map((rule) => rule.label).join(" and ")}.`
          : "."),
    };
  }

  const [firstRule, ...otherRules] = keywordRules;
  if (firstRule) {
    const category = getOwaspCategory(firstRule.primary)!;
    return {
      primary: firstRule.primary,
      primaryTitle: category.title,
      related: byRank([
        ...firstRule.related,
        ...otherRules.flatMap((rule) => [rule.primary, ...rule.related]),
      ]).filter((id) => id !== firstRule.primary),
      wstgIds: unique(keywordRules.flatMap((rule) => rule.wstgIds)),
      confidence: otherRules.length === 0 ? "medium" : "low",
      source: "keyword",
      rationale:
        `Finding text matches the ${firstRule.label} pattern, which the OWASP Top 10:2025 ` +
        `classifies as ${firstRule.primary} ${category.title}` +
        (otherRules.length ? ` (also matches ${otherRules.length} other pattern(s) — confirm manually)` : "") +
        ". No CWE or WSTG test case was supplied.",
    };
  }

  return {
    related: [],
    wstgIds: [],
    confidence: "low",
    source: "unmapped",
    rationale:
      "No explicit OWASP category, WSTG test case, CWE or recognisable vulnerability " +
      "pattern was supplied, so this finding is left unmapped. Add a CWE, WSTG test id " +
      "or an explicit OWASP Top 10:2025 category to classify it.",
  };
}

export function describeOwaspMapping(result: OwaspMappingResult): string {
  if (!result.primary) {
    return `Unmapped to the OWASP Top 10:2025. ${result.rationale}`;
  }
  const related = result.related.length ? ` (related: ${result.related.join(", ")})` : "";
  return `${result.primary} ${result.primaryTitle ?? ""}${related} — ${result.confidence} confidence via ${result.source}: ${result.rationale}`;
}

export function suggestWstgTestsForFinding(input: OwaspMappingInput): string[] {
  const haystack = [input.title, input.description, input.contextSummary, input.evidence]
    .filter(Boolean)
    .join(" \n ");
  const fromRules = KEYWORD_RULES.filter((rule) => ruleMatches(haystack, rule)).flatMap(
    (rule) => rule.wstgIds,
  );
  const fromCwe = primaryCategoryForLexicon(input.cwe ?? "");
  const fromCategory = fromCwe
    ? getOwaspCategory(fromCwe.primary)?.wstgFocus ?? []
    : [];
  return unique([...fromRules, ...fromCategory]).slice(0, 8);
}