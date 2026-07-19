/**
 * Coordinates the browser-facing PR workspace without knowing anything about
 * React or HTTP. A request token is tied to the selection that created it, so
 * late responses cannot overwrite a newer repository or PR.
 */
export class PrWorkspaceCoordinator {
  private prListRevision = 0;
  private detailsRevision = 0;

  beginPrList(repoId: string) {
    return { repoId, revision: ++this.prListRevision };
  }

  isCurrentPrList(request: { repoId: string; revision: number }) {
    return request.revision === this.prListRevision;
  }

  beginDetails(prId: string) {
    return { prId, revision: ++this.detailsRevision };
  }

  isCurrentDetails(request: { prId: string; revision: number }) {
    return request.revision === this.detailsRevision;
  }

  selectPr(currentPrId: string, availablePrIds: string[]) {
    if (currentPrId && availablePrIds.includes(currentPrId)) return currentPrId;
    return availablePrIds[0] ?? "";
  }

  reconcilePrSelection(currentPrId: string, availablePrIds: string[]) {
    return this.selectPr(currentPrId, availablePrIds);
  }
}
