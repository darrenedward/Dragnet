import { prisma } from "@/src/lib/prisma";

export interface DashboardMetrics {
  projects: number;
  scans: number;
  bugsFixed: number;
}

/** Aggregates the small set of success metrics shown in the dashboard header. */
export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const [projects, scans, bugsFixed] = await Promise.all([
    prisma.repository.count(),
    prisma.reviewRun.count({ where: { status: "completed" } }),
    prisma.bugFixEvent.count(),
  ]);

  return { projects, scans, bugsFixed };
}
