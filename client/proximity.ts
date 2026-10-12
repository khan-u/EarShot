/** Adapted from ts-client Game.updateProximityVoice and the relative teleport
 * hook at 0106096. Coordinates here are integer tiles; game rendering is absent.
 * Source hashes and the limits of the historical attribution are in provenance.json. */
export interface Participant { id: number; name: string; x: number; y: number }
export const PROXIMITY_TILES = 15;
export function neighbors(self: Participant, roster: Participant[]): Set<number> {
    const result = new Set<number>();
    for (const peer of roster) {
        if (peer.id === self.id) continue;
        const dx = peer.x - self.x, dy = peer.y - self.y;
        if (dx * dx + dy * dy <= PROXIMITY_TILES * PROXIMITY_TILES) result.add(peer.id);
    }
    return result;
}
export function moved(position: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
    if (![dx, dy].every(v => Number.isInteger(v) && Math.abs(v) <= 10000)) throw new Error("movement must use integer tile deltas");
    const result = { x: position.x + dx, y: position.y + dy };
    if (Math.abs(result.x) > 100000 || Math.abs(result.y) > 100000) throw new Error("position outside experiment bounds");
    return result;
}
