import { randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import archiver from "archiver";
import busboy from "busboy";
import extract from "extract-zip";
import { AuthStorage } from "./auth-storage.js";
import {
	cleanExpiredUploadSessions,
	createDmpSpawnHook,
	createHttpResourceLoader,
	defaultHttpModel,
	getHttpSkillAgentTools,
	getMimeType,
	getOrCreateAgentOptionsMap,
	getOrCreateAgentSessionMap,
	getUserIdOrReject,
	getUserRootDir,
	getUserSessionDir,
	httpModelConfig,
	parseJsonBody,
	sendError,
	sendJson,
	uploadLimits,
	uploadSessions,
	validateFileSize,
	validateFileType,
	validatePathWithinCwd,
} from "./http-api-shared.js";
import { type CreateAgentSessionOptions, createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { createLibreChatTools } from "./tools/document-generator.js";
import { getCachedMCPTools } from "./tools/mcp-registry.js";

export async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	// --- Phase 1: Parse multipart using busboy (binary-safe, no toString) ---
	const fields: Record<string, string> = {};
	const fileEntries: { filename: string; buffer: Buffer }[] = [];

	await new Promise<void>((resolve, reject) => {
		const bb = busboy({ headers: req.headers });

		bb.on("field", (name: string, val: string) => {
			fields[name] = val;
		});

		bb.on(
			"file",
			(
				_name: string,
				stream: NodeJS.ReadableStream,
				info: { filename: string; encoding: string; mimeType: string },
			) => {
				const chunks: Buffer[] = [];
				stream.on("data", (chunk: Buffer) => chunks.push(chunk));
				stream.on("end", () => {
					// busboy 用 Latin-1 解析 filename，中文需要还原为 UTF-8
					const utf8Filename = Buffer.from(info.filename, "latin1").toString("utf-8");
					fileEntries.push({ filename: utf8Filename, buffer: Buffer.concat(chunks) });
				});
				stream.on("error", reject);
			},
		);

		bb.on("finish", resolve);
		bb.on("error", reject);
		req.pipe(bb);
	});

	const agentId = fields.agentId;
	const sessionId = fields.sessionId;
	const targetPath = fields.path ?? "";
	const originalFilename = fields.originalFilename;

	if (!agentId) {
		sendError(res, 400, "agentId is required");
		return;
	}
	if (!sessionId) {
		sendError(res, 400, "sessionId is required");
		return;
	}

	// --- Phase 2: Get or create agent session ---
	const agentSessions = getOrCreateAgentSessionMap(agentId);
	const agentOptions = getOrCreateAgentOptionsMap(agentId);
	let session = agentSessions.get(sessionId);

	console.log(
		`[HTTP] /upload called, agentId=${agentId}, sessionId=${sessionId}, hasSession=${!!session}, defaultHttpModel=${defaultHttpModel?.provider}/${defaultHttpModel?.id}`,
	);

	if (!session) {
		try {
			const cwd = getUserSessionDir(userId, agentId, sessionId);
			const libreChatTools = createLibreChatTools(cwd);
			const allTools = [...libreChatTools, ...getCachedMCPTools(), ...getHttpSkillAgentTools()];
			const sessionDir = join(cwd, ".pi", "sessions");
			const sessionManager = SessionManager.create(cwd, sessionDir);
			const resourceLoader = await createHttpResourceLoader(userId, cwd);

			let authStorage: AuthStorage | undefined;
			if (httpModelConfig?.apiKey && defaultHttpModel) {
				authStorage = AuthStorage.create();
				authStorage.setRuntimeApiKey(defaultHttpModel.provider, httpModelConfig.apiKey);
			}

			const options: CreateAgentSessionOptions = {
				cwd,
				sessionManager,
				allowedRoot: getUserRootDir(userId),
				bashToolOptions: { spawnHook: createDmpSpawnHook(userId, agentId, sessionId), sandbox: true },
				customTools: allTools,
				model: defaultHttpModel,
				continueSession: false,
				forceModel: true,
				resourceLoader,
				authStorage,
			};
			const result = await createAgentSession(options);
			session = result.session;
			agentSessions.set(sessionId, session);
			agentOptions.set(sessionId, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			sendError(res, 500, `Failed to create session: ${message}`);
			return;
		}
	}

	// --- Phase 3: Write files (Buffer, binary-safe) ---
	const cwd = session.sessionManager.getCwd();
	const uploadDir = targetPath ? validatePathWithinCwd(cwd, targetPath) : cwd;

	if (!existsSync(uploadDir)) {
		mkdirSync(uploadDir, { recursive: true });
	}

	for (const file of fileEntries) {
		const filename = originalFilename || file.filename;
		writeFileSync(join(uploadDir, filename), file.buffer);
	}

	sendJson(res, 200, { success: true, path: uploadDir });
}

export async function handleFilesList(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const agentId = urlObj.searchParams.get("agentId");
	const sessionId = urlObj.searchParams.get("sessionId");
	const path = urlObj.searchParams.get("path") ?? "";
	const showHidden = urlObj.searchParams.get("showHidden") !== "false";

	if (!agentId) {
		sendError(res, 400, "agentId is required");
		return;
	}
	if (!sessionId) {
		sendError(res, 400, "sessionId is required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	const targetDir = path ? validatePathWithinCwd(cwd, path) : cwd;

	if (!existsSync(targetDir)) {
		sendJson(res, 200, { files: [], currentPath: path });
		return;
	}

	try {
		const files: { name: string; size: number; lastModified: string; isDirectory: boolean; isHidden: boolean }[] = [];
		const entries = readdirSync(targetDir, { withFileTypes: true });

		for (const entry of entries) {
			const isHidden = entry.name.startsWith(".");
			if (!showHidden && isHidden) continue;
			const fullPath = join(targetDir, entry.name);
			const stats = statSync(fullPath);
			files.push({
				name: entry.name,
				size: stats.size,
				lastModified: stats.mtime.toISOString(),
				isDirectory: entry.isDirectory(),
				isHidden,
			});
		}

		files.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});

		sendJson(res, 200, { files, currentPath: path, showHidden });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to list files: ${message}`);
	}
}

export async function handleFilesDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		path: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const agentId = body?.agentId;
	const sessionId = body?.sessionId;
	const path = body?.path;

	if (!agentId) {
		sendError(res, 400, "agentId is required");
		return;
	}
	if (!sessionId) {
		sendError(res, 400, "sessionId is required");
		return;
	}
	if (!path) {
		sendError(res, 400, "path is required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetPath: string;
	try {
		targetPath = validatePathWithinCwd(cwd, path);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(targetPath)) {
		sendError(res, 404, `Path not found: ${path}`);
		return;
	}

	try {
		const stats = statSync(targetPath);
		if (stats.isDirectory()) {
			rmSync(targetPath, { recursive: true, force: true });
		} else {
			unlinkSync(targetPath);
		}
		sendJson(res, 200, { success: true, path: targetPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to delete: ${message}`);
	}
}

export async function handleFilesDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const agentId = urlObj.searchParams.get("agentId");
	const sessionId = urlObj.searchParams.get("sessionId");
	const path = urlObj.searchParams.get("path") ?? "";

	if (!agentId) {
		sendError(res, 400, "agentId is required");
		return;
	}
	if (!sessionId) {
		sendError(res, 400, "sessionId is required");
		return;
	}
	if (!path) {
		sendError(res, 400, "path is required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetPath: string;
	try {
		targetPath = validatePathWithinCwd(cwd, path);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(targetPath)) {
		sendError(res, 404, `Path not found: ${path}`);
		return;
	}

	const stats = statSync(targetPath);
	const pathName = targetPath.split(/[\\/]/).pop() ?? "download";

	if (stats.isFile()) {
		const encodedFilename = encodeURIComponent(pathName);
		res.writeHead(200, {
			"Content-Disposition": `attachment; filename="${encodedFilename}"`,
			"Content-Type": "application/octet-stream",
			"Content-Length": stats.size,
		});

		const readStream = createReadStream(targetPath);
		readStream.pipe(res);

		readStream.on("error", (error) => {
			console.error("File download error:", error);
			if (!res.writableEnded) {
				res.end();
			}
		});
	} else if (stats.isDirectory()) {
		const zipFilename = encodeURIComponent(`${pathName}.zip`);
		res.writeHead(200, {
			"Content-Disposition": `attachment; filename="${zipFilename}"`,
			"Content-Type": "application/zip",
		});

		const archive = archiver("zip", { zlib: { level: 9 } });
		archive.on("error", (err: Error) => {
			console.error("Archive error:", err);
			if (!res.writableEnded) {
				res.end();
			}
		});

		archive.pipe(res);
		archive.directory(targetPath, pathName);
		archive.finalize();
	}
}

export async function handleFilesUnzip(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		path: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const agentId = body?.agentId;
	const sessionId = body?.sessionId;
	const path = body?.path;

	if (!agentId) {
		sendError(res, 400, "agentId is required");
		return;
	}
	if (!sessionId) {
		sendError(res, 400, "sessionId is required");
		return;
	}
	if (!path) {
		sendError(res, 400, "path is required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetPath: string;
	try {
		targetPath = validatePathWithinCwd(cwd, path);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(targetPath)) {
		sendError(res, 404, `File not found: ${path}`);
		return;
	}

	const stats = statSync(targetPath);
	if (!stats.isFile()) {
		sendError(res, 400, "Not a zip file");
		return;
	}

	const ext = targetPath.split(".").pop()?.toLowerCase();
	if (ext !== "zip") {
		sendError(res, 400, "File is not a zip archive");
		return;
	}

	try {
		const extractedDir = targetPath.replace(/\.zip$/, "");
		await extract(targetPath, { dir: extractedDir });
		sendJson(res, 200, { success: true, extractedTo: extractedDir });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to unzip: ${message}`);
	}
}

export async function handleFilesBatchDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		paths: string[];
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, paths } = body;

	if (!agentId || !sessionId || !paths) {
		sendError(res, 400, "agentId, sessionId, and paths are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	const deleted: string[] = [];
	const errors: string[] = [];

	for (const path of paths) {
		let targetPath: string;
		try {
			targetPath = validatePathWithinCwd(cwd, path);
		} catch {
			errors.push(`${path}: path outside working directory`);
			continue;
		}
		if (existsSync(targetPath)) {
			try {
				const stats = statSync(targetPath);
				if (stats.isDirectory()) {
					rmSync(targetPath, { recursive: true, force: true });
				} else {
					unlinkSync(targetPath);
				}
				deleted.push(path);
			} catch (error) {
				errors.push(`${path}: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		} else {
			errors.push(`${path}: not found`);
		}
	}

	sendJson(res, 200, { success: true, deleted, errors: errors.length > 0 ? errors : undefined });
}

export async function handleFilesBatchDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		paths: string[];
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, paths } = body;

	if (!agentId || !sessionId || !paths || paths.length === 0) {
		sendError(res, 400, "agentId, sessionId, and paths are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);

	res.writeHead(200, {
		"Content-Disposition": `attachment; filename="batch-download.zip"`,
		"Content-Type": "application/zip",
	});

	const archive = archiver("zip", { zlib: { level: 9 } });
	archive.on("error", (err: Error) => {
		console.error("Archive error:", err);
		if (!res.writableEnded) {
			res.end();
		}
	});

	archive.pipe(res);

	for (const path of paths) {
		let targetPath: string;
		try {
			targetPath = validatePathWithinCwd(cwd, path);
		} catch {
			continue;
		}
		if (existsSync(targetPath)) {
			const stats = statSync(targetPath);
			const baseName = targetPath.split(/[\\/]/).pop() ?? path;
			if (stats.isFile()) {
				archive.file(targetPath, { name: baseName });
			} else if (stats.isDirectory()) {
				archive.directory(targetPath, baseName);
			}
		}
	}

	archive.finalize();
}

export async function handleFilesMkdir(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		path: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, path } = body;

	if (!agentId || !sessionId || !path) {
		sendError(res, 400, "agentId, sessionId, and path are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetPath: string;
	try {
		targetPath = validatePathWithinCwd(cwd, path);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (existsSync(targetPath)) {
		sendError(res, 409, `Directory already exists: ${path}`);
		return;
	}

	try {
		mkdirSync(targetPath, { recursive: true });
		sendJson(res, 200, { success: true, path: targetPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to create directory: ${message}`);
	}
}

export async function handleFilesRename(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		oldPath: string;
		newPath: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, oldPath, newPath } = body;

	if (!agentId || !sessionId || !oldPath || !newPath) {
		sendError(res, 400, "agentId, sessionId, oldPath, and newPath are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let oldFullPath: string;
	let newFullPath: string;
	try {
		oldFullPath = validatePathWithinCwd(cwd, oldPath);
		newFullPath = validatePathWithinCwd(cwd, newPath);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(oldFullPath)) {
		sendError(res, 404, `Source not found: ${oldPath}`);
		return;
	}

	if (existsSync(newFullPath)) {
		sendError(res, 409, `Target already exists: ${newPath}`);
		return;
	}

	try {
		renameSync(oldFullPath, newFullPath);
		sendJson(res, 200, { success: true, newPath: newFullPath });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to rename: ${message}`);
	}
}

export async function handleFilesMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		sourcePaths: string[];
		targetDir: string;
		operation: "move" | "copy";
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, sourcePaths, targetDir, operation } = body;

	if (!agentId || !sessionId || !sourcePaths || !targetDir || !operation) {
		sendError(res, 400, "agentId, sessionId, sourcePaths, targetDir, and operation are required");
		return;
	}

	if (operation !== "move" && operation !== "copy") {
		sendError(res, 400, "operation must be 'move' or 'copy'");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetFullDir: string;
	try {
		targetFullDir = validatePathWithinCwd(cwd, targetDir);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid target directory");
		return;
	}

	if (!existsSync(targetFullDir)) {
		sendError(res, 404, `Target directory not found: ${targetDir}`);
		return;
	}

	if (!statSync(targetFullDir).isDirectory()) {
		sendError(res, 400, `Target is not a directory: ${targetDir}`);
		return;
	}

	const moved: string[] = [];
	const errors: string[] = [];

	for (const sourcePath of sourcePaths) {
		let sourceFullPath: string;
		try {
			sourceFullPath = validatePathWithinCwd(cwd, sourcePath);
		} catch {
			errors.push(`${sourcePath}: path outside working directory`);
			continue;
		}
		const targetFullPath = join(targetFullDir, sourcePath.split(/[\\/]/).pop()!);

		if (!existsSync(sourceFullPath)) {
			errors.push(`${sourcePath}: not found`);
			continue;
		}

		try {
			const stats = statSync(sourceFullPath);
			if (stats.isDirectory()) {
				const nestedTarget = join(targetFullDir, sourcePath.split(/[\\/]/).pop()!);
				if (operation === "copy") {
					function copyDir(src: string, dest: string): void {
						mkdirSync(dest, { recursive: true });
						const entries = readdirSync(src, { withFileTypes: true });
						for (const entry of entries) {
							const srcPath = join(src, entry.name);
							const destPath = join(dest, entry.name);
							if (entry.isDirectory()) {
								copyDir(srcPath, destPath);
							} else {
								require("node:fs").copyFileSync(srcPath, destPath);
							}
						}
					}
					copyDir(sourceFullPath, nestedTarget);
				} else {
					renameSync(sourceFullPath, nestedTarget);
				}
			} else {
				if (operation === "copy") {
					require("node:fs").copyFileSync(sourceFullPath, targetFullPath);
				} else {
					renameSync(sourceFullPath, targetFullPath);
				}
			}
			moved.push(sourcePath);
		} catch (error) {
			errors.push(`${sourcePath}: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	sendJson(res, 200, { success: true, moved, errors: errors.length > 0 ? errors : undefined });
}

export async function handleFilesDetails(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const agentId = urlObj.searchParams.get("agentId");
	const sessionId = urlObj.searchParams.get("sessionId");
	const path = urlObj.searchParams.get("path");

	if (!agentId || !sessionId || !path) {
		sendError(res, 400, "agentId, sessionId, and path are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let targetPath: string;
	try {
		targetPath = validatePathWithinCwd(cwd, path);
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(targetPath)) {
		sendError(res, 404, `Path not found: ${path}`);
		return;
	}

	try {
		const stats = statSync(targetPath);
		const name = path.split(/[\\/]/).pop() ?? path;
		sendJson(res, 200, {
			name,
			path,
			size: stats.size,
			lastModified: stats.mtime.toISOString(),
			isDirectory: stats.isDirectory(),
			mimeType: stats.isFile() ? getMimeType(name) : undefined,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to get details: ${message}`);
	}
}

export async function handleFilesSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const urlObj = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const agentId = urlObj.searchParams.get("agentId");
	const sessionId = urlObj.searchParams.get("sessionId");
	const path = urlObj.searchParams.get("path") ?? "";
	const pattern = urlObj.searchParams.get("pattern") ?? "";
	const type = urlObj.searchParams.get("type");

	if (!agentId || !sessionId) {
		sendError(res, 400, "agentId and sessionId are required");
		return;
	}

	const cwd = getUserSessionDir(userId, agentId, sessionId);
	let searchDir: string;
	try {
		searchDir = path ? validatePathWithinCwd(cwd, path) : cwd;
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid path");
		return;
	}

	if (!existsSync(searchDir)) {
		sendError(res, 404, `Directory not found: ${path}`);
		return;
	}

	try {
		const results: { name: string; path: string; size: number; lastModified: string; isDirectory: boolean }[] = [];
		const regex = pattern ? new RegExp(pattern, "i") : null;

		function searchDirRecursive(dir: string, basePath: string): void {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const fullPath = join(dir, entry.name);
				const relativePath = join(basePath, entry.name).replace(/^[\\/]/, "");

				if (regex && !regex.test(entry.name)) {
					if (entry.isDirectory()) {
						searchDirRecursive(fullPath, relativePath);
					}
					continue;
				}

				if (type === "file" && entry.isDirectory()) continue;
				if (type === "folder" && entry.isFile()) continue;

				const stats = statSync(fullPath);
				results.push({
					name: entry.name,
					path: relativePath,
					size: stats.size,
					lastModified: stats.mtime.toISOString(),
					isDirectory: entry.isDirectory(),
				});
			}
		}

		searchDirRecursive(searchDir, path);

		results.sort((a, b) => a.name.localeCompare(b.name));
		sendJson(res, 200, { files: results, currentPath: path });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		sendError(res, 500, `Failed to search: ${message}`);
	}
}

export async function handleFilesUploadInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		agentId: string;
		sessionId: string;
		filename: string;
		totalSize: number;
		totalChunks: number;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { agentId, sessionId, filename, totalSize, totalChunks } = body;

	if (!agentId || !sessionId || !filename || !totalSize || !totalChunks) {
		sendError(res, 400, "agentId, sessionId, filename, totalSize, and totalChunks are required");
		return;
	}

	if (!validateFileType(filename)) {
		sendError(res, 400, `File type not allowed: ${filename}`);
		return;
	}

	if (!validateFileSize(totalSize)) {
		sendError(res, 400, `File size exceeds limit: ${totalSize} > ${uploadLimits.maxFileSize}`);
		return;
	}

	cleanExpiredUploadSessions();

	const uploadId = randomUUID();
	const uploadSession = {
		uploadId,
		agentId,
		sessionId,
		filename,
		totalSize,
		totalChunks,
		chunks: new Map<number, { chunkIndex: number; chunk: Buffer; received: boolean }>(),
		createdAt: Date.now(),
	};

	uploadSessions.set(uploadId, uploadSession);
	sendJson(res, 200, { uploadId, expiresIn: 86400 });
}

export async function handleFilesUploadChunk(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		uploadId: string;
		chunkIndex: number;
		chunk: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { uploadId, chunkIndex, chunk } = body;

	if (!uploadId || chunkIndex === undefined || !chunk) {
		sendError(res, 400, "uploadId, chunkIndex, and chunk are required");
		return;
	}

	const session = uploadSessions.get(uploadId);
	if (!session) {
		sendError(res, 404, "Upload session not found");
		return;
	}

	try {
		const chunkBuffer = Buffer.from(chunk, "base64");
		session.chunks.set(chunkIndex, {
			chunkIndex,
			chunk: chunkBuffer,
			received: true,
		});

		const receivedCount = Array.from(session.chunks.values()).filter((c) => c.received).length;
		sendJson(res, 200, { success: true, received: receivedCount, total: session.totalChunks });
	} catch (_error) {
		sendError(res, 400, "Invalid chunk data");
	}
}

export async function handleFilesUploadComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const userId = getUserIdOrReject(req, res);
	if (!userId) return;

	const body = await parseJsonBody<{
		uploadId: string;
		targetPath?: string;
	}>(req);

	if (!body) {
		sendError(res, 400, "Invalid JSON body");
		return;
	}

	const { uploadId, targetPath } = body;

	if (!uploadId) {
		sendError(res, 400, "uploadId is required");
		return;
	}

	const session = uploadSessions.get(uploadId);
	if (!session) {
		sendError(res, 404, "Upload session not found");
		return;
	}

	if (session.chunks.size !== session.totalChunks) {
		sendError(res, 400, `Incomplete upload: ${session.chunks.size}/${session.totalChunks} chunks received`);
		return;
	}

	const cwd = getUserSessionDir(userId, session.agentId, session.sessionId);
	let uploadDir: string;
	try {
		uploadDir = targetPath ? validatePathWithinCwd(cwd, targetPath) : cwd;
	} catch (error) {
		sendError(res, 403, error instanceof Error ? error.message : "Invalid target path");
		return;
	}

	if (!existsSync(uploadDir)) {
		mkdirSync(uploadDir, { recursive: true });
	}

	const sortedChunks = Array.from(session.chunks.values()).sort((a, b) => a.chunkIndex - b.chunkIndex);
	const totalBuffer = Buffer.concat(sortedChunks.map((c) => c.chunk));
	const finalPath = join(uploadDir, session.filename);

	writeFileSync(finalPath, totalBuffer);
	uploadSessions.delete(uploadId);

	sendJson(res, 200, { success: true, path: finalPath });
}
