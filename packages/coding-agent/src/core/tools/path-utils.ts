import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Directories that may be read (and their scripts executed) but never written.
 * Populated at runtime via {@link addAllowedReadPrefix} (the HTTP API registers
 * `/app/skill-repo`, `~/.pi/agent/skills`, and `~/.pi/agent/prompts` on startup),
 * so no deployment-specific paths are hard-coded here.
 */
const ALLOWED_READ_PREFIXES: string[] = [];

export function addAllowedReadPrefix(prefix: string): void {
	const normalized = prefix.replace(/[\\/]+$/, "");
	if (normalized && !ALLOWED_READ_PREFIXES.includes(normalized)) {
		ALLOWED_READ_PREFIXES.push(normalized);
	}
}

export function isAllowedReadPath(resolvedPath: string): boolean {
	const normalized = resolvePath(resolvedPath);
	return ALLOWED_READ_PREFIXES.some(
		(prefix) =>
			normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.startsWith(`${prefix}${sep}`),
	);
}

export function isPathWithinCwd(resolvedPath: string, cwd: string): boolean {
	const normalizedCwd = resolvePath(cwd);
	const normalizedPath = resolvePath(resolvedPath);
	return normalizedPath === normalizedCwd || normalizedPath.startsWith(normalizedCwd + sep);
}

export function resolveToCwd(filePath: string, cwd: string, allowedRoot?: string): string {
	const expanded = expandPath(filePath);
	const normalizedCwd = resolvePath(cwd);
	const root = resolvePath(allowedRoot ?? cwd);
	if (isAbsolute(expanded)) {
		if (isAllowedReadPath(resolvePath(expanded))) {
			return expanded;
		}
		const resolved = resolvePath(expanded);
		if (!isPathWithinCwd(resolved, root)) {
			const parts = resolved.split(/[/\\]/);
			const fileName = parts[parts.length - 1];
			return resolvePath(normalizedCwd, fileName);
		}
		return resolved;
	}
	const resolved = resolvePath(normalizedCwd, expanded);
	if (!isPathWithinCwd(resolved, root)) {
		const parts = resolved.split(/[/\\]/);
		const fileName = parts[parts.length - 1];
		return resolvePath(normalizedCwd, fileName);
	}
	return resolved;
}

export function resolveToCwdStrict(filePath: string, cwd: string, allowedRoot?: string): string {
	const expanded = expandPath(filePath);
	const normalizedCwd = resolvePath(cwd);
	const root = resolvePath(allowedRoot ?? cwd);
	const assertWithin = (candidate: string) => {
		if (candidate !== root && !candidate.startsWith(root + sep)) {
			throw new Error(
				`Access denied: path '${filePath}' is outside the allowed area '${root}'. ` +
					`You can only access files within the allowed area.`,
			);
		}
	};
	let resolved: string;
	if (isAbsolute(expanded)) {
		resolved = resolvePath(expanded);
		assertWithin(resolved);
	} else {
		resolved = resolvePath(normalizedCwd, expanded);
		assertWithin(resolved);
	}

	// Symlink-escape guard. A symlink that lives inside the allowed area but
	// points outside it would pass the lexical check above. Resolve the real
	// location of the target — or, for a not-yet-existing file, its parent
	// directory — and confirm it stays within the real root. This blocks writes
	// through cwd-local symlinks that escape the sandbox.
	const realRoot = resolveRealPath(root);
	let realTarget: string;
	if (existsSync(resolved)) {
		realTarget = resolveRealPath(resolved);
	} else {
		const parent = dirname(resolved);
		const realParent = existsSync(parent) ? resolveRealPath(parent) : parent;
		realTarget = resolvePath(realParent, basename(resolved));
	}
	if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
		throw new Error(
			`Access denied: path '${filePath}' resolves (via symlink) to '${realTarget}' which is outside the allowed area '${realRoot}'. ` +
				`Symlinks that escape the allowed area are not permitted.`,
		);
	}
	return resolved;
}

export function resolveRealPath(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch {
		return filePath;
	}
}

export function resolveReadPath(filePath: string, cwd: string, allowedRoot?: string): string {
	const resolved = resolveToCwd(filePath, cwd, allowedRoot);

	if (fileExists(resolved)) {
		return resolved;
	}

	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
