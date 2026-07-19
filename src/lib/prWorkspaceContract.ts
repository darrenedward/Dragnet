export interface PrWorkspaceContract<ReadModel, Commands> {
  readModel: ReadModel;
  commands: Commands;
}

export function createPrWorkspaceContract<ReadModel, Commands>(
  readModel: ReadModel,
  commands: Commands,
): PrWorkspaceContract<ReadModel, Commands> {
  return { readModel, commands };
}
