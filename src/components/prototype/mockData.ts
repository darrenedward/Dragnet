/** PROTOTYPE — throwaway fake data. */

export type ProtoPr = {
  id: string;
  title: string;
  githubPrNumber: number;
  ticketNumber: number | null;
  branch: string;
  status: "Completed" | "Pending" | "In Progress" | "Failed";
  rating: number | null;
  mergeReason: string | null;
  mergeReady: boolean;
  logLines: string[];
};

export type ProtoRepo = {
  id: string;
  name: string;
  githubUrl: string;
  cloneOk: boolean;
  cloneError: string | null;
  indexOk: boolean;
  /** Installed + processing → GitHub notifies Dragnet on push/PR */
  webhookConnected: boolean;
  needsReviewCount: number;
  prs: ProtoPr[];
};

export const REPOS: ProtoRepo[] = [
  {
    id: "dragnet",
    name: "Dragnet",
    githubUrl: "https://github.com/darrenedward/Dragnet",
    cloneOk: true,
    cloneError: null,
    indexOk: true,
    webhookConnected: false,
    needsReviewCount: 1,
    prs: [
      {
        id: "pr-80",
        title: "test: Dragnet runner smoke (install/tier checks)",
        githubPrNumber: 80,
        ticketNumber: null,
        branch: "test/dragnet-runner-smoke",
        status: "Completed",
        rating: null,
        mergeReason: "no score — findings rejected after LLM rated 10",
        mergeReady: false,
        logLines: [
          "clone ok · index ready",
          "[install] exit=0",
          "JSON finalReview: rating=10, 0 findings",
          "verifier rejected findings — nulling rating (was 10)",
          "Review complete — not merge-ready (no score)",
        ],
      },
    ],
  },
  {
    id: "nwatrade",
    name: "NWATrade",
    githubUrl: "https://github.com/darrenedward/NWATrade",
    cloneOk: false,
    cloneError: "cannot change to '/app/repos/nwatrade-…': No such file or directory",
    indexOk: true,
    webhookConnected: false,
    needsReviewCount: 6,
    prs: [
      {
        id: "pr-31",
        title: "feat(admin): Add PM User page (search + role multi-select + promote)",
        githubPrNumber: 31,
        ticketNumber: 25,
        branch: "ticket-25-admin-pm-user",
        status: "Pending",
        rating: null,
        mergeReason: null,
        mergeReady: false,
        logLines: [
          "prelude blocked gate=CLONE_FAILED",
          "fatal: cannot change to '/app/repos/nwatrade-…': No such file or directory",
        ],
      },
      {
        id: "pr-30",
        title: "Promote endpoint: ambassadors",
        githubPrNumber: 30,
        ticketNumber: 24,
        branch: "ticket-24-promote",
        status: "Completed",
        rating: 7,
        mergeReason: "7/10 below merge bar (need 8+)",
        mergeReady: false,
        logLines: ["Review complete — 7/10"],
      },
      {
        id: "pr-29",
        title: "Admin search ambassadors",
        githubPrNumber: 29,
        ticketNumber: 23,
        branch: "ticket-23-search",
        status: "Completed",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
        logLines: ["Review complete — 6/10"],
      },
      {
        id: "pr-28",
        title: "Middleware hardening",
        githubPrNumber: 28,
        ticketNumber: 22,
        branch: "ticket-22-middleware",
        status: "Completed",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
        logLines: ["Review complete — 6/10"],
      },
      {
        id: "pr-27",
        title: "RBAC foundation: schema",
        githubPrNumber: 27,
        ticketNumber: 21,
        branch: "ticket-21-rbac",
        status: "Completed",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
        logLines: ["Review complete — 6/10"],
      },
      {
        id: "pr-18",
        title: "ticket 18 dragnet followups",
        githubPrNumber: 18,
        ticketNumber: 18,
        branch: "ticket-18-followups",
        status: "Completed",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
        logLines: ["Review complete — 6/10"],
      },
    ],
  },
  {
    id: "nwapages",
    name: "NWAPages",
    githubUrl: "https://github.com/darrenedward/NWAPages",
    cloneOk: true,
    cloneError: null,
    indexOk: true,
    webhookConnected: true,
    needsReviewCount: 0,
    prs: [
      {
        id: "pr-42",
        title: "feat: correspondence list",
        githubPrNumber: 42,
        ticketNumber: 146,
        branch: "ticket-146-correspondence",
        status: "Completed",
        rating: 9,
        mergeReason: null,
        mergeReady: true,
        logLines: ["install ok", "lint ok", "rating 9/10", "Merge ready"],
      },
    ],
  },
];
