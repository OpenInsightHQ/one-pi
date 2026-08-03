import { resolve as resolvePath } from "node:path";
import { isAllowedReadPath, isPathWithinCwd } from "./path-utils.js";

const UNIX_ABSOLUTE_PATH = /(?:^|[\s=:;"'`|&;(])[/~][^\s;|&>()\]"']*/g;
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s=:;"'`|&;(])[A-Za-z]:[\\/][^\s;|&>()\]"']*/g;
const REDIRECT_PATH = /(?:>{1,2}|<)\s*([^\s;|&>()\]"']+)/g;
const CD_COMMAND = /\bcd\s+([^\s;|&>()\]"']+)/g;
const TILDE_PATH = /(?:^|[\s=:;"'`|&;(])~([/\\][^\s;|&>()\]"']*)?/g;
const PATH_ARGUMENT =
	/(?:^|[\s=:;"'`|&;()])(\.+[/\\][^\s;|&>()\]"']*|[/~][^\s;|&>()\]"']*|[A-Za-z]:[\\/][^\s;|&>()\]"']*)/g;

/**
 * Write redirect: captures the target of `>` and `>>` (optionally with a file-descriptor
 * prefix such as `2>`). Input redirects (`<`) are NOT matched here — those are reads.
 */
const WRITE_REDIRECT = /(?:\d)?>>?\s*([^\s;|&>()\]"']+)/g;

/**
 * Commands whose path arguments are all write targets (they create, modify, move, or delete).
 * For `mv` both source and destination count as writes (the source is removed).
 */
const WRITE_ALL_ARGS = new Set([
	"rm",
	"rmdir",
	"mv",
	"rename",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"shred",
	"unlink",
	"mkfifo",
	"mknod",
	"install",
	"tee",
]);

/**
 * Commands where only the last path argument (the destination) is a write target.
 * Sources are reads.
 */
const WRITE_LAST_ARG = new Set(["cp", "copy", "scp"]);

function extractMatches(pattern: RegExp, text: string, group: number): string[] {
	const results: string[] = [];
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null = pattern.exec(text);
	while (match !== null) {
		results.push(group === 0 ? match[0].trim() : match[group]);
		match = pattern.exec(text);
	}
	return results;
}

function extractPathsFromCommand(command: string): string[] {
	const paths: string[] = [];
	const normalized = command.replace(/\\n/g, " ");

	paths.push(...extractMatches(UNIX_ABSOLUTE_PATH, normalized, 0));
	paths.push(...extractMatches(WINDOWS_ABSOLUTE_PATH, normalized, 0));
	paths.push(...extractMatches(REDIRECT_PATH, normalized, 1));
	paths.push(...extractMatches(CD_COMMAND, normalized, 1));
	paths.push(...extractMatches(TILDE_PATH, normalized, 0));
	paths.push(...extractMatches(PATH_ARGUMENT, normalized, 0));

	return [...new Set(paths)];
}

/** Split a command line into segments at shell operators (`;`, `|`, `&`, newline), respecting quotes. */
function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let buf = "";
	let single = false;
	let dbl = false;
	const flush = () => {
		const s = buf.trim();
		if (s) segments.push(s);
		buf = "";
	};
	for (const ch of command) {
		if (ch === "'" && !dbl) {
			single = !single;
			buf += ch;
			continue;
		}
		if (ch === '"' && !single) {
			dbl = !dbl;
			buf += ch;
			continue;
		}
		if (!single && !dbl && "|;&\n".includes(ch)) {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return segments;
}

/** Tokenize a single command segment by whitespace, respecting quotes. Returns bare tokens (quotes kept). */
function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = [];
	let buf = "";
	let single = false;
	let dbl = false;
	const flush = () => {
		if (buf.length) {
			tokens.push(buf);
			buf = "";
		}
	};
	for (const ch of segment) {
		if (ch === "'" && !dbl) {
			single = !single;
			continue;
		}
		if (ch === '"' && !single) {
			dbl = !dbl;
			continue;
		}
		if (!single && !dbl && /\s/.test(ch)) {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return tokens;
}

function stripQuotes(token: string): string {
	return token.replace(/^['"]|['"]$/g, "").replace(/^=/, "");
}

function commandBaseName(cmd: string): string {
	const parts = stripQuotes(cmd).split(/[/\\]/);
	return parts[parts.length - 1];
}

/**
 * Collect the resolved absolute paths that the given command writes to. Covers output
 * redirects (`>`, `>>`) and common write/delete/move commands. This is best-effort
 * static analysis; it is a defense-in-depth layer on top of the OS-level sandbox, not
 * a complete sandbox by itself.
 */
function collectWriteTargets(command: string, cwd: string): Set<string> {
	const normalizedCwd = resolvePath(cwd);
	const resolved = new Set<string>();

	for (const raw of extractMatches(WRITE_REDIRECT, command, 1)) {
		const t = stripQuotes(raw);
		if (t) resolved.add(resolvePath(normalizedCwd, t));
	}

	for (const seg of splitCommandSegments(command)) {
		const tokens = tokenizeSegment(seg);
		if (tokens.length === 0) continue;
		const base = commandBaseName(tokens[0]);
		const args = tokens.slice(1);
		const pathArgs = args.filter((a) => !a.startsWith("-") || a === "-");

		if (WRITE_ALL_ARGS.has(base)) {
			for (const a of pathArgs) resolved.add(resolvePath(normalizedCwd, stripQuotes(a)));
		} else if (WRITE_LAST_ARG.has(base) && pathArgs.length > 0) {
			resolved.add(resolvePath(normalizedCwd, stripQuotes(pathArgs[pathArgs.length - 1])));
		} else if (base === "dd") {
			for (const a of args) {
				const m = a.match(/^of=['"]?(.+?)['"]?$/);
				if (m) resolved.add(resolvePath(normalizedCwd, m[1]));
			}
		} else if (base === "sed" && args.some((a) => a === "-i" || /^-[^-]*i/.test(a))) {
			for (const a of pathArgs) resolved.add(resolvePath(normalizedCwd, stripQuotes(a)));
		} else if (base === "awk" && args.some((a) => a === "-i") && args.includes("inplace")) {
			for (const a of pathArgs) resolved.add(resolvePath(normalizedCwd, stripQuotes(a)));
		}
	}

	return resolved;
}

export function validateCommandSandbox(command: string, cwd: string, allowedRoot?: string): string | null {
	const normalizedCwd = resolvePath(cwd);
	const root = resolvePath(allowedRoot ?? cwd);

	// `cd` into a directory outside the working directory changes the effective
	// working directory for the rest of the command, which makes script outputs
	// and other relative-path artifacts land outside the session directory. This
	// is a common failure when running skill scripts (e.g. "cd /app/skill-repo/...
	// && python scripts/main.py"). Block it even when the target is on the
	// allowed-read list: read files and run scripts by absolute path, but keep
	// the working directory fixed at the session directory. Note: the cd check is
	// always against the session cwd (not allowedRoot) so outputs never leave the
	// session directory.
	const normalizedCommand = command.replace(/\\n/g, " ");
	for (const rawTarget of extractMatches(CD_COMMAND, normalizedCommand, 1)) {
		const cleanTarget = rawTarget.replace(/^['"]|['"]$/g, "");
		const resolved = resolvePath(normalizedCwd, cleanTarget);
		if (!isPathWithinCwd(resolved, normalizedCwd)) {
			const scriptHint = `${resolved.replace(/\\/g, "/")}/scripts/main.py`;
			return (
				`Access denied: 'cd ${cleanTarget}' resolves to '${resolved}' which is outside the working directory '${normalizedCwd}'. ` +
				`Sandbox mode forbids 'cd' out of the working directory, because it makes script outputs land in the wrong place. ` +
				`Run the script by absolute path without 'cd' (e.g. 'python ${scriptHint} ...') so outputs are written to the working directory.`
			);
		}
	}

	const writeTargets = collectWriteTargets(command, cwd);

	for (const rawPath of extractPathsFromCommand(command)) {
		const cleanPath = rawPath.replace(/^['"]|['"]$/g, "").replace(/^=/, "");
		if (!cleanPath || cleanPath === "/" || cleanPath === "~") {
			return `Access denied: cannot access root path '${cleanPath}'. You can only access files within the allowed area '${root}'.`;
		}

		if (cleanPath.startsWith("~")) {
			return `Access denied: cannot access home directory path '${cleanPath}'. You can only access files within the allowed area '${root}'.`;
		}

		const resolved = resolvePath(normalizedCwd, cleanPath);
		const isWrite = writeTargets.has(resolved);

		if (isWrite) {
			// Read-only (allowed-read) directories may be read and executed, but never written.
			if (isAllowedReadPath(resolved)) {
				return (
					`Access denied: cannot write to '${cleanPath}' — '${resolved}' is inside a read-only directory. ` +
					`Read-only directories (/app/skill-repo, ~/.pi/agent/skills, ~/.pi/agent/prompts) may be read and their scripts executed, ` +
					`but files there cannot be created, modified, moved, or deleted. Write to a path inside the working directory instead.`
				);
			}
			if (!isPathWithinCwd(resolved, root)) {
				return `Access denied: cannot write to '${cleanPath}' which resolves to '${resolved}' outside the allowed area '${root}'. You can only write within the allowed area.`;
			}
		} else {
			if (isAllowedReadPath(resolved)) {
				continue;
			}
			if (!isPathWithinCwd(resolved, root)) {
				return `Access denied: path '${cleanPath}' resolves to '${resolved}' which is outside the allowed area '${root}'. You can only access files within the allowed area.`;
			}
		}
	}

	return null;
}
