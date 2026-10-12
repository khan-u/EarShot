import { expect, it } from "vitest";
import { moved, neighbors } from "./proximity";
it("retains the inclusive 15-tile Euclidean proximity rule and excludes self", () => {
    const self = { id: 1, name: "a", x: 0, y: 0 };
    expect([...neighbors(self, [self, { id: 2, name: "b", x: 9, y: 12 }, { id: 3, name: "c", x: 16, y: 0 }])]).toEqual([2]);
});
it("moves by relative integer tiles and returns to the original position", () => {
    const start = { x: 100, y: 40 };
    const out = moved(start, -25, 0);
    expect(out).toEqual({ x: 75, y: 40 });
    expect(moved(out, 25, 0)).toEqual(start);
    expect(() => moved(start, NaN, 0)).toThrow(); expect(() => moved(start, 1.5, 0)).toThrow();
});
