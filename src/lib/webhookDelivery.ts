import crypto from "node:crypto";
import { prisma } from "./prisma";

export interface CreateDeliveryLogInput {
  repoId: string;
  provider: "github" | "gitlab";
  eventType: string;
  deliveryGuid: string;
  hostedMode: boolean;
  prNumber?: number;
}

export async function createDeliveryLog(data: CreateDeliveryLogInput): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.webhookDelivery.create({
    data: {
      id,
      repoId: data.repoId,
      provider: data.provider,
      eventType: data.eventType,
      deliveryGuid: data.deliveryGuid,
      status: "received",
      hostedMode: data.hostedMode,
      prNumber: data.prNumber ?? null,
    },
  });
  return id;
}

export async function updateDeliveryStatus(
  id: string,
  status: "received" | "completed" | "failed" | "ignored",
  error?: string,
): Promise<void> {
  await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status,
      error: error ?? null,
      completedAt: new Date(),
    },
  });
}
