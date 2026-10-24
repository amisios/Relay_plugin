import { usercolors } from "../User";

type UserColor = (typeof usercolors)[number];

/** Deterministic color from a stable string (e.g. a user id): same input always
 * yields the same swatch, so a given collaborator keeps one color across clients
 * and sessions instead of a random one that can collide. */
export function colorFromString(seed: string): UserColor {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return usercolors[(h >>> 0) % usercolors.length];
}

/** Build a UserColor from an explicit hex string chosen by the user. */
export function userColorFromHex(hex: string): UserColor {
	return { color: hex, light: hex + "33" };
}
