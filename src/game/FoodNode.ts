// A food source with a finite amount. Ants take up to their carry capacity per
// trip instead of swallowing the whole node (the starter's food value depended
// on WHO found it — a super major got 7 food from the same node a minor got 1
// from). Pure module, no Phaser, so it stays unit-testable.
export interface FoodNode {
  x: number;
  y: number;
  amount: number;
  initialAmount: number;
}

export function createFoodNode(x: number, y: number, amount: number): FoodNode {
  return { x, y, amount, initialAmount: amount };
}

/** Take up to `capacity` from the node. Returns the amount actually taken. */
export function takeFood(node: FoodNode, capacity: number): number {
  const taken = Math.min(capacity, Math.max(0, node.amount));
  node.amount -= taken;
  return taken;
}
