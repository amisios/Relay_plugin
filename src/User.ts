"use strict";

import * as random from "lib0/random";
type UserColor = {
	color: string;
	light: string;
};

export const usercolors: UserColor[] = [
	{ color: "#30bced", light: "#30bced33" },
	{ color: "#6eeb83", light: "#6eeb8333" },
	{ color: "#ffbc42", light: "#ffbc4233" },
	{ color: "#ecd444", light: "#ecd44433" },
	{ color: "#ee6352", light: "#ee635233" },
	{ color: "#9ac2c9", light: "#9ac2c933" },
	{ color: "#8acb88", light: "#8acb8833" },
	{ color: "#1be7ff", light: "#1be7ff33" },
];

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

export const PROFILE_AVATAR_THUMBNAIL = "100x100";
export const ANONYMOUS_PROFILE_NAME = "Anonymous";

interface ProfileRecord extends Record<string, unknown> {
	avatar?: string;
	displayName?: string;
	email?: string;
	name?: string;
	picture?: string;
}

interface ProfileFileOptions {
	thumb: string;
}

export type ProfileFileUrl = (
	record: Record<string, unknown>,
	filename: string,
	options: ProfileFileOptions,
) => string;

export function preferredProfileField(
	preferred: string | undefined,
	fallback: string,
): string {
	return preferred || fallback;
}

export function resolveProfileName(
	record: ProfileRecord | null | undefined,
	fallback: string,
	streamerMode = false,
): string {
	return preferredProfileField(
		record?.displayName,
		streamerMode
			? ANONYMOUS_PROFILE_NAME
			: preferredProfileField(record?.name, fallback),
	);
}

export function resolveProfileEmail(
	record: ProfileRecord | null | undefined,
	fallback: string,
	streamerMode = false,
): string {
	return streamerMode ? "" : preferredProfileField(record?.email, fallback);
}

export function resolveProfileAvatar(
	record: ProfileRecord | null | undefined,
	getFileUrl?: ProfileFileUrl,
): string {
	if (!record?.avatar || !getFileUrl) {
		return "";
	}
	return getFileUrl(record, record.avatar, {
		thumb: PROFILE_AVATAR_THUMBNAIL,
	});
}

export function resolveProfilePicture(
	record: ProfileRecord | null | undefined,
	fallback: string,
	getFileUrl?: ProfileFileUrl,
	streamerMode = false,
): string {
	const avatarUrl = resolveProfileAvatar(record, getFileUrl);
	if (avatarUrl) {
		return avatarUrl;
	}
	return streamerMode ? "" : preferredProfileField(record?.picture, fallback);
}

export class User {
	color: UserColor;

	constructor(
		public id: string,
		public name: string,
		public email: string,
		public picture: string,
		public token: string,
	) {
		this.color = usercolors[random.uint32() % usercolors.length];
	}
}
