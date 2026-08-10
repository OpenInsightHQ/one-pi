import mongoose, { type Connection } from "mongoose";

/**
 * MongoDB connection manager.
 *
 * Uses a cached global singleton (same pattern as arp/LibreChat `api/db/connect.js`)
 * so the connection is shared across all callers in the process.
 *
 * The connection is **optional**: if `MONGO_URI` is not set, `isMongoEnabled()`
 * returns false and all data-layer calls gracefully no-op. This lets pi run in
 * standalone mode without MongoDB, while enabling the authorized-skill + ACL
 * features when the database is configured.
 */

const MONGO_URI = process.env.MONGO_URI;

let cachedConnection: Connection | null = null;
let cachedPromise: Promise<Connection> | null = null;

/** Returns true when MONGO_URI is configured. */
export function isMongoEnabled(): boolean {
	return Boolean(MONGO_URI);
}

/** Returns the active connection, or null if not connected / not configured. */
export function getCachedConnection(): Connection | null {
	if (cachedConnection && cachedConnection.readyState === 1) {
		return cachedConnection;
	}
	return null;
}

function parseConnectOptions(): Record<string, unknown> {
	const num = (v: string | undefined): number | undefined => {
		if (!v) return undefined;
		const n = Number.parseInt(v, 10);
		return Number.isNaN(n) ? undefined : n;
	};

	const opts: Record<string, unknown> = {
		serverSelectionTimeoutMS: num(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) ?? 5000,
	};
	const maxPool = num(process.env.MONGO_MAX_POOL_SIZE);
	const minPool = num(process.env.MONGO_MIN_POOL_SIZE);
	const maxConnecting = num(process.env.MONGO_MAX_CONNECTING);
	const maxIdle = num(process.env.MONGO_MAX_IDLE_TIME_MS);
	const waitQueue = num(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS);
	if (maxPool !== undefined) opts.maxPoolSize = maxPool;
	if (minPool !== undefined) opts.minPoolSize = minPool;
	if (maxConnecting !== undefined) opts.maxConnecting = maxConnecting;
	if (maxIdle !== undefined) opts.maxIdleTimeMS = maxIdle;
	if (waitQueue !== undefined) opts.waitQueueTimeoutMS = waitQueue;

	const autoIndex = process.env.MONGO_AUTO_INDEX;
	if (autoIndex !== undefined) opts.autoIndex = autoIndex === "true";
	const autoCreate = process.env.MONGO_AUTO_CREATE;
	if (autoCreate !== undefined) opts.autoCreate = autoCreate === "true";

	return opts;
}

/**
 * Establishes (or returns the cached) Mongoose connection.
 *
 * Throws if `MONGO_URI` is not configured. Callers that can tolerate the
 * absence of MongoDB should check `isMongoEnabled()` first.
 */
export async function getDb(): Promise<Connection> {
	if (!MONGO_URI) {
		throw new Error("MONGO_URI environment variable is not set");
	}

	if (cachedConnection && cachedConnection.readyState === 1) {
		return cachedConnection;
	}

	if (!cachedPromise) {
		mongoose.set("strictQuery", true);
		const opts = parseConnectOptions();
		cachedPromise = mongoose.connect(MONGO_URI, opts).then((m) => m.connection);
	}

	try {
		cachedConnection = await cachedPromise;
		return cachedConnection;
	} catch (error) {
		cachedPromise = null;
		throw error;
	}
}

/**
 * Connects to MongoDB on HTTP server startup.
 *
 * If `MONGO_URI` is not set, logs an informational message and returns false
 * (pi runs in personal-skills-only mode).
 * If the connection fails, logs a warning and returns false so the server
 * still starts — authorized skills are simply unavailable.
 */
export async function connectMongo(): Promise<boolean> {
	if (!isMongoEnabled()) {
		console.log("[MongoDB] MONGO_URI not set — authorized skills and ACL disabled (personal-skills-only mode)");
		return false;
	}

	try {
		const conn = await getDb();
		console.log(`[MongoDB] Connected to ${conn.host}:${conn.port}/${conn.name}`);
		return true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[MongoDB] Connection failed — authorized skills disabled: ${msg}`);
		return false;
	}
}

/** Disconnects and clears the cached connection. Intended for tests / cleanup. */
export async function disconnectMongo(): Promise<void> {
	if (cachedPromise) {
		try {
			await mongoose.disconnect();
		} catch {}
	}
	cachedConnection = null;
	cachedPromise = null;
}
