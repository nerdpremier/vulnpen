import SessionsModel from "../models/Sessions/Sessions.model";

export type EngagementMode = "pentest";

// ─── Shared types ───────────────────────────────────────────────────

export interface DiscoveredCredential {
  username: string;
  secret: string;
  secretType: "password" | "hash" | "token" | "key" | "cookie" | "other";
  source: string;
  validOn: string[];
}

export interface CreatedFile {
  path: string;
  description: string;
}

export interface AttemptedApproach {
  technique: string;
  target: string;
  result: "success" | "failed" | "partial";
  detail: string;
}

// ─── Pentest types ──────────────────────────────────────────────────

export interface DiscoveredHost {
  ip: string;
  hostname?: string;
  os?: string;
  status: "up" | "down" | "unknown";
}

export interface DiscoveredService {
  host: string;
  port: number;
  protocol: "tcp" | "udp";
  service: string;
  version?: string;
  notes?: string;
}

export interface Vulnerability {
  vulnerabilityId: string;
  fingerprint: string;
  host: string;
  service?: string;
  endpoint?: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  cvss?: { score: number; vector: string };
  likelihood?: number;
  impactRating?: number;
  cwe?: string;
  evidence: string;
  stepsToReproduce: string[];
  contextSummary: string;
  impact?: string;
  remediation?: string;
  exploited: boolean;
  cve?: string;
  status: "open" | "confirmed" | "remediated" | "accepted";
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveShell {
  shellId: string;
  host: string;
  user: string;
  privilegeLevel: "user" | "root" | "system" | "service";
  type: "reverse" | "bind" | "ssh" | "web";
  obtainedVia?: string;
}

/**
 * A C2 callback the agent is currently working through. Lives here — not in Mongo —
 * so the agent keeps track of its own implants across a long engagement.
 */
export interface ActiveImplant {
  callbackDisplayId: number;
  host: string;
  user?: string;
  domain?: string;
  os?: string;
  integrityLevel?: string;
  agentType?: string;
  /** host:port of a live SOCKS proxy through this implant, if one is open. */
  socksProxy?: string;
}

// ─── EngagementState class ──────────────────────────────────────────

/**
 * The part of the state that lives only here, persisted to the session
 * document by the persister adapter so it survives across agent runs, consent
 * resumes and restarts. Vulnerabilities are absent — they persist through
 * `session.vulnerabilities` (see upsertSessionVulnerability); declaredTarget
 * and scope come from `session.engagementContext`.
 */
export interface EngagementStateSnapshot {
  hosts: DiscoveredHost[];
  services: DiscoveredService[];
  credentials: DiscoveredCredential[];
  shells: ActiveShell[];
  implants: ActiveImplant[];
  keyDiscoveries: string[];
  files: CreatedFile[];
  approachesTried: AttemptedApproach[];
  nextSteps: string[];
}

/** Writes the snapshot somewhere durable. Wired to the session document by
 *  engagementStateFromSession; tests construct the state without one. */
export type EngagementStatePersister = (snapshot: EngagementStateSnapshot) => Promise<void>;

export class EngagementState {
  mode: EngagementMode;

  private persister?: EngagementStatePersister;
  private dirty = false;

  // Pentest fields
  /** The Target entered for the engagement - the only field that arms the
   *  deterministic scope gate. */
  declaredTarget?: string;
  scope?: string;
  hosts: DiscoveredHost[] = [];
  services: DiscoveredService[] = [];
  vulnerabilities: Vulnerability[] = [];
  shells: ActiveShell[] = [];
  implants: ActiveImplant[] = [];
  keyDiscoveries: string[] = [];

  // Shared fields
  credentials: DiscoveredCredential[] = [];
  files: CreatedFile[] = [];
  approachesTried: AttemptedApproach[] = [];
  nextSteps: string[] = [];

  constructor(mode: EngagementMode = "pentest", persister?: EngagementStatePersister) {
    this.mode = mode;
    this.persister = persister;
  }

  toPromptBlock(): string {
    return this.renderPentestState();
  }

  isEmpty(): boolean {
    return (
      this.hosts.length === 0 &&
      this.services.length === 0 &&
      this.credentials.length === 0 &&
      this.vulnerabilities.length === 0 &&
      this.shells.length === 0 &&
      this.implants.length === 0 &&
      this.keyDiscoveries.length === 0 &&
      this.files.length === 0 &&
      this.approachesTried.length === 0 &&
      this.nextSteps.length === 0
    );
  }

  private renderPentestState(): string {
    const sections: string[] = [
      `<engagement_state type="pentest">`,
    ];

    // Per-category render caps: this block is the volatile tail of the system
    // prompt and is re-sent uncached on every tool-loop iteration, so a
    // session that accumulates hundreds of services or attempted approaches
    // would otherwise grow the per-call token cost without bound. High-value,
    // low-volume sections (vulnerabilities, shells, implants, next steps) are
    // never capped; high-volume ones keep their most recent entries and state
    // how many were omitted.
    if (this.hosts.length) {
      sections.push("## Hosts");
      sections.push(
        ...this.capped(this.hosts, 25, (h) => {
          const hostname = h.hostname ? ` (${h.hostname})` : "";
          const os = h.os ? ` — ${h.os}` : "";
          return `- ${h.ip}${hostname} [${h.status}]${os}`;
        }),
      );
    }

    if (this.services.length) {
      sections.push("## Services");
      sections.push(
        ...this.capped(this.services, 25, (s) => {
          const ver = s.version ? ` ${s.version}` : "";
          const notes = s.notes ? ` (${s.notes})` : "";
          return `- ${s.host}:${s.port}/${s.protocol} — ${s.service}${ver}${notes}`;
        }),
      );
    }

    if (this.credentials.length) {
      sections.push("## Credentials");
      sections.push(
        ...this.capped(this.credentials, 20, (c) => {
          const valid =
            c.validOn.length > 0
              ? `, valid on: ${c.validOn.join(", ")}`
              : "";
          return `- ${c.username}:${c.secret} (${c.secretType}) — from: ${c.source}${valid}`;
        }),
      );
    }

    if (this.vulnerabilities.length) {
      sections.push("## Vulnerabilities");
      for (const v of this.vulnerabilities) {
        const svc = v.service ? `:${v.service}` : "";
        const exploited = v.exploited ? "EXPLOITED" : "not yet exploited";
        const cve = v.cve ? ` (${v.cve})` : "";
        const scoring = [
          v.cvss ? `CVSS v3.0 base score ${v.cvss.score} (${v.cvss.vector})` : "not rated",
          v.cwe ?? "",
        ].filter(Boolean).join(", ");
        sections.push(
          `- [${v.severity.toUpperCase()}] ${v.title} on ${v.host}${svc} — ${exploited}${cve}${scoring ? ` — ${scoring}` : ""}`,
        );
        // contextSummary can be a paragraph per finding; the volatile tail is
        // re-sent uncached on every iteration, so keep the prompt copy short.
        // The full text persists in the session document and the report.
        if (v.contextSummary) {
          const summary =
            v.contextSummary.length > 200
              ? `${v.contextSummary.slice(0, 200).trimEnd()} …`
              : v.contextSummary;
          sections.push(`  Context: ${summary}`);
        }
      }
    }

    if (this.shells.length) {
      sections.push("## Active Shells");
      for (const s of this.shells) {
        const via = s.obtainedVia ? ` (${s.obtainedVia})` : "";
        sections.push(
          `- ${s.shellId}: ${s.user}@${s.host} [${s.privilegeLevel}] via ${s.type}${via}`,
        );
      }
    }

    if (this.implants.length) {
      sections.push("## C2 Implants");
      for (const i of this.implants) {
        const principal = [i.domain, i.user].filter(Boolean).join("\\") || "?";
        const integrity = i.integrityLevel ? ` [${i.integrityLevel}]` : "";
        const agent = i.agentType ? ` via ${i.agentType}` : "";
        const socks = i.socksProxy ? ` — SOCKS at ${i.socksProxy}` : "";
        sections.push(
          `- callback ${i.callbackDisplayId}: ${principal}@${i.host}${integrity}${agent}${socks}`,
        );
      }
    }

    if (this.keyDiscoveries.length) {
      sections.push("## Key Discoveries");
      sections.push(
        ...this.capped(this.keyDiscoveries, 20, (kd) => `- ${kd}`),
      );
    }

    this.renderShared(sections);
    sections.push("</engagement_state>");
    return sections.join("\n");
  }

  // ─── Mutations ────────────────────────────────────────────────────
  // The only ways tools change the recordable categories. Each marks the
  // state dirty; callers flush once per tool call, which is what keeps a
  // successful update_engagement_state on the session document. Vulnerability
  // mutations never dirty the state — that category persists through
  // session.vulnerabilities, not the snapshot.

  addHost(host: DiscoveredHost): void {
    this.hosts.push(host);
    this.dirty = true;
  }

  addService(service: DiscoveredService): void {
    this.services.push(service);
    this.dirty = true;
  }

  addCredential(credential: DiscoveredCredential): void {
    this.credentials.push(credential);
    this.dirty = true;
  }

  addShell(shell: ActiveShell): void {
    this.shells.push(shell);
    this.dirty = true;
  }

  addKeyDiscovery(discovery: string): void {
    this.keyDiscoveries.push(discovery);
    this.dirty = true;
  }

  addFile(file: CreatedFile): void {
    this.files.push(file);
    this.dirty = true;
  }

  logApproach(approach: AttemptedApproach): void {
    this.approachesTried.push(approach);
    this.dirty = true;
  }

  setNextSteps(steps: string[]): void {
    this.nextSteps = steps;
    this.dirty = true;
  }

  /** Insert-or-merge an implant by callback display id. */
  upsertImplant(implant: ActiveImplant): void {
    const existing = this.implants.find(
      (i) => i.callbackDisplayId === implant.callbackDisplayId,
    );
    if (existing) {
      Object.assign(existing, implant);
    } else {
      this.implants.push(implant);
    }
    this.dirty = true;
  }

  /** Insert-or-merge a vulnerability by id or fingerprint — the same dedup
   *  upsertSessionVulnerability applies to the document, so the in-memory
   *  copy can never drift from what was persisted. */
  upsertVulnerability(vulnerability: Vulnerability): void {
    const existingIndex = this.vulnerabilities.findIndex(
      (v) =>
        v.vulnerabilityId === vulnerability.vulnerabilityId ||
        (v.fingerprint && v.fingerprint === vulnerability.fingerprint),
    );
    if (existingIndex >= 0) this.vulnerabilities[existingIndex] = vulnerability;
    else this.vulnerabilities.push(vulnerability);
  }

  removeVulnerability(vulnerabilityId: string): void {
    this.vulnerabilities = this.vulnerabilities.filter(
      (v) => v.vulnerabilityId !== vulnerabilityId,
    );
  }

  // ─── Persistence ──────────────────────────────────────────────────

  toSnapshot(): EngagementStateSnapshot | undefined {
    if (this.isEmpty()) return undefined;
    return {
      hosts: this.hosts,
      services: this.services,
      credentials: this.credentials,
      shells: this.shells,
      implants: this.implants,
      keyDiscoveries: this.keyDiscoveries,
      files: this.files,
      approachesTried: this.approachesTried,
      nextSteps: this.nextSteps,
    };
  }

  /**
   * Write the snapshot through the persister when a mutation is pending.
   * Without a persister (tests, ad-hoc states) this is a no-op. The dirty
   * flag is cleared only after the write resolves, so a failed write is
   * retried by the next flush rather than silently lost.
   */
  async flush(): Promise<void> {
    if (!this.dirty || !this.persister) return;
    const snapshot = this.toSnapshot();
    if (!snapshot) {
      this.dirty = false;
      return;
    }
    await this.persister(snapshot);
    this.dirty = false;
  }

  private capped<T>(
    items: T[],
    cap: number,
    render: (item: T) => string,
  ): string[] {
    if (items.length <= cap) return items.map(render);
    return [
      `(+${items.length - cap} earlier entries omitted from context)`,
      ...items.slice(items.length - cap).map(render),
    ];
  }

  private renderShared(sections: string[]): void {
    if (this.files.length) {
      sections.push("## Files Created");
      sections.push(
        ...this.capped(this.files, 15, (f) => `- ${f.path}: ${f.description}`),
      );
    }

    if (this.approachesTried.length) {
      sections.push("## Approaches Tried");
      sections.push(
        ...this.capped(this.approachesTried, 20, (a) => {
          return `- [${a.result.toUpperCase()}] ${a.technique} → ${a.target}: ${a.detail}`;
        }),
      );
    }

    if (this.nextSteps.length) {
      sections.push("## Next Steps");
      for (const n of this.nextSteps) {
        sections.push(`- ${n}`);
      }
    }
  }
}

// ─── Session bootstrap ──────────────────────────────────────────────

/**
 * Rebuild the in-memory engagement state from the persisted session document:
 * the declared boundary from engagementContext, the findings from
 * session.vulnerabilities, and everything the state itself owns from the
 * `engagementState` snapshot — hosts, services, credentials, shells,
 * implants, key discoveries, files, approaches, next steps. The returned
 * state carries the session-document persister, so flushing after a
 * successful update_engagement_state keeps the snapshot current for the next
 * run, consent resume or restart. Shared by the main agent loop and the
 * consent path so every execution context records state through this module.
 * Tests pass their own `persister` to capture the snapshot.
 */
export function engagementStateFromSession(
  session: any,
  persister?: EngagementStatePersister,
): EngagementState {
  const sessionId = session?.sessionId;
  const resolvedPersister =
    persister ??
    (sessionId
      ? async (snapshot: EngagementStateSnapshot) => {
          await SessionsModel.updateOne(
            { sessionId },
            { $set: { engagementState: snapshot } },
          );
        }
      : undefined);
  const engagementState = new EngagementState("pentest", resolvedPersister);
  // Declared engagement boundary. Only the Target arms the scope gate; the free
  // text below is what the gate then parses into the host allowlist, so a stray
  // domain in the Scope prose widens the boundary instead of redefining it.
  engagementState.declaredTarget = session?.engagementContext?.target ?? "";
  engagementState.scope = [
    session?.engagementContext?.target,
    session?.engagementContext?.scope,
  ]
    .filter(Boolean)
    .join(" ");
  engagementState.vulnerabilities = (session?.vulnerabilities ?? []).map(
    (vulnerability: any) => ({
      vulnerabilityId: vulnerability.vulnerabilityId,
      fingerprint: vulnerability.fingerprint,
      host: vulnerability.host,
      service: vulnerability.service,
      endpoint: vulnerability.endpoint,
      title: vulnerability.title,
      severity: vulnerability.severity,
      cvss: vulnerability.cvss
        ? { score: vulnerability.cvss.score, vector: vulnerability.cvss.vector }
        : undefined,
      likelihood: vulnerability.likelihood,
      impactRating: vulnerability.impactRating,
      cwe: vulnerability.cwe,
      evidence: vulnerability.evidence,
      stepsToReproduce: vulnerability.stepsToReproduce,
      contextSummary: vulnerability.contextSummary,
      impact: vulnerability.impact,
      remediation: vulnerability.remediation,
      exploited: vulnerability.exploited,
      cve: vulnerability.cve,
      status: vulnerability.status,
      source: vulnerability.source,
      createdAt: vulnerability.createdAt,
      updatedAt: vulnerability.updatedAt,
    }),
  );
  const snapshot = session?.engagementState;
  if (snapshot && typeof snapshot === "object") {
    const list = (value: any): any[] => (Array.isArray(value) ? value : []);
    engagementState.hosts = list(snapshot.hosts);
    engagementState.services = list(snapshot.services);
    engagementState.credentials = list(snapshot.credentials);
    engagementState.shells = list(snapshot.shells);
    engagementState.implants = list(snapshot.implants);
    engagementState.keyDiscoveries = list(snapshot.keyDiscoveries);
    engagementState.files = list(snapshot.files);
    engagementState.approachesTried = list(snapshot.approachesTried);
    engagementState.nextSteps = list(snapshot.nextSteps);
  }
  return engagementState;
}
