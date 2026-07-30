/** PROTOTYPE — throwaway fake data. */

export type ProtoPrStatus = "pending" | "queued" | "completed";
export type ProtoSize = "small" | "medium" | "oversized";

export type ProtoPr = {
  id: string;
  title: string;
  githubPrNumber: number;
  ticketNumber: number | null;
  branch: string;
  /** Sidebar only shows these three */
  status: ProtoPrStatus;
  size: ProtoSize;
  rating: number | null;
  mergeReason: string | null;
  mergeReady: boolean;
};

export type ProtoRepo = {
  id: string;
  name: string;
  githubUrl: string;
  cloneOk: boolean;
  indexOk: boolean;
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
        status: "completed",
        size: "small",
        rating: null,
        mergeReason: "no score — findings rejected after LLM rated 10",
        mergeReady: false,
      },
    ],
  },
  {
    id: "nwatrade",
    name: "NWATrade",
    githubUrl: "https://github.com/darrenedward/NWATrade",
    cloneOk: false,
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
        status: "pending",
        size: "medium",
        rating: null,
        mergeReason: null,
        mergeReady: false,
      },
      {
        id: "pr-30",
        title: "Promote endpoint: ambassadors",
        githubPrNumber: 30,
        ticketNumber: 24,
        branch: "ticket-24-promote",
        status: "completed",
        size: "small",
        rating: 7,
        mergeReason: "7/10 below merge bar (need 8+)",
        mergeReady: false,
      },
      {
        id: "pr-29",
        title: "Admin search ambassadors",
        githubPrNumber: 29,
        ticketNumber: 23,
        branch: "ticket-23-search",
        status: "completed",
        size: "small",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
      },
      {
        id: "pr-28",
        title: "Middleware hardening",
        githubPrNumber: 28,
        ticketNumber: 22,
        branch: "ticket-22-middleware",
        status: "completed",
        size: "medium",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
      },
      {
        id: "pr-27",
        title: "RBAC foundation: schema",
        githubPrNumber: 27,
        ticketNumber: 21,
        branch: "ticket-21-rbac",
        status: "completed",
        size: "small",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
      },
      {
        id: "pr-18",
        title: "ticket 18 dragnet followups",
        githubPrNumber: 18,
        ticketNumber: 18,
        branch: "ticket-18-followups",
        status: "completed",
        size: "oversized",
        rating: 6,
        mergeReason: "6/10 below merge bar",
        mergeReady: false,
      },
    ],
  },
  {
    id: "nwapages",
    name: "NWAPages",
    githubUrl: "https://github.com/darrenedward/NWAPages",
    cloneOk: true,
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
        status: "completed",
        size: "small",
        rating: 9,
        mergeReason: null,
        mergeReady: true,
      },
      {
        id: "pr-41",
        title: "chore: deps bump",
        githubPrNumber: 41,
        ticketNumber: null,
        branch: "chore/deps",
        status: "queued",
        size: "small",
        rating: null,
        mergeReason: null,
        mergeReady: false,
      },
    ],
  },
];
