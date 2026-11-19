export async function expectedRejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => { throw new Error("Expected the operation to reject, but it fulfilled"); }, error => error);
}
