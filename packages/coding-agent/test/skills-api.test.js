#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { spawn } from "child_process";
import archiver from "archiver";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_BASE = process.env.API_BASE || "http://localhost:3000";
const API_KEY = process.env.PI_API_KEY || "";
const TEST_USER_ID = process.env.TEST_USER_ID || "test-user-" + randomUUID().slice(0, 8);

function headers(extra = {}) {
  const h = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (API_KEY) {
    h["api-key"] = API_KEY;
  }
  return h;
}

async function request(method, path, body, options = {}) {
  const url = `${API_BASE}${path}`;
  const fetchOptions = {
    method,
    headers: headers(options.contentType ? { "Content-Type": options.contentType } : {}),
  };

  if (body && !options.contentType) {
    fetchOptions.body = JSON.stringify(body);
  } else if (body && options.contentType) {
    fetchOptions.body = body;
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Server did not start in time");
}

function createTestSkillZip(skillName, description, category) {
  const tempDir = join(__dirname, `.test-skill-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  const skillContent = `---
name: ${skillName}
description: ${description}
---
# ${skillName}

This is a test skill for ${category}.
`;

  writeFileSync(join(tempDir, "SKILL.md"), skillContent);

  const zipPath = join(__dirname, `.test-${randomUUID()}.zip`);
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(tempDir, skillName);
    archive.finalize();
    output.on("close", () => resolve(zipPath));
    archive.on("error", reject);
  });
}

async function uploadSkillZip(category, zipPath) {
  const fileBuffer = readFileSync(zipPath);
  const boundary = `----FormBoundary${randomUUID()}`;

  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${zipPath.split("/").pop()}"\r\nContent-Type: application/zip\r\n\r\n`,
  ];

  const bodyStart = bodyParts.join("");
  const bodyEnd = `\r\n--${boundary}--`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(bodyStart),
    fileBuffer,
    Buffer.from(bodyEnd),
  ]);

  const response = await fetch(`${API_BASE}/skills/upload`, {
    method: "POST",
    headers: {
      ...headers(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuffer,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function cleanupFile(filePath) {
  try {
    const { unlinkSync, rmSync } = await import("fs");
    if (existsSync(filePath)) {
      const stat = (await import("fs")).statSync(filePath);
      if (stat.isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
    }
  } catch {}
}

async function cleanupTestSkill(skillName, category) {
  const { execSync } = await import("child_process");
  const skillRepoDir = process.env.SKILL_REPO_DIR || "/app/skill-repo";
  const skillPath = join(skillRepoDir, category, skillName);

  try {
    execSync(`rm -rf "${skillPath}"`, { stdio: "ignore" });
  } catch {}

  const globalSkillsDir = join(process.env.HOME || "/root", ".pi/agent/skills");
  const globalLinkPath = join(globalSkillsDir, skillName);
  try {
    execSync(`rm -f "${globalLinkPath}"`, { stdio: "ignore" });
  } catch {}

  const userSkillsDir = join(process.cwd(), ".pi/http-sessions", TEST_USER_ID, "skills");
  const userLinkPath = join(userSkillsDir, skillName);
  try {
    execSync(`rm -rf "${userSkillsDir}"`, { stdio: "ignore" });
  } catch {}
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("Skills API Test Suite");
  console.log("=".repeat(60));
  console.log(`API Base: ${API_BASE}`);
  console.log(`Test User ID: ${TEST_USER_ID}`);
  console.log();

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${e.message}`);
      failed++;
    }
  }

  await test("Health check", async () => {
    const { status, data } = await request("GET", "/health");
    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (data.status !== "ok") throw new Error(`Expected status "ok", got ${data.status}`);
  });

  await test("List skills (GET /skills)", async () => {
    const { status, data } = await request("GET", "/skills");
    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!Array.isArray(data.skills)) throw new Error(`Expected data.skills to be an array`);
  });

  await test("List skills with groupBy=source", async () => {
    const { status, data } = await request("GET", "/skills?groupBy=source");
    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!Array.isArray(data.groups)) throw new Error(`Expected data.groups to be an array`);
  });

  await test("List skills with groupBy=category", async () => {
    const { status, data } = await request("GET", "/skills?groupBy=category");
    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!Array.isArray(data.categories)) throw new Error(`Expected data.categories to be an array`);
  });

  const testSkillName = "test-skill-" + randomUUID().slice(0, 8);
  const testCategory = "test-category";

  await test("Upload skill (POST /skills/upload)", async () => {
    const zipPath = await createTestSkillZip(testSkillName, "A test skill for API testing", testCategory);
    const { status, data } = await uploadSkillZip(testCategory, zipPath);
    await cleanupFile(zipPath);

    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!data.success) throw new Error(`Expected success=true`);
    if (!data.skill) throw new Error(`Expected skill object in response`);
    if (!data.skill.name) throw new Error(`Expected skill.name in response`);
    if (!data.skill.description) throw new Error(`Expected skill.description in response`);
    if (!data.skill.category) throw new Error(`Expected skill.category in response`);
    if (!data.skill.path) throw new Error(`Expected skill.path in response`);
  });

  await test("Upload skill fails without category", async () => {
    const zipPath = await createTestSkillZip("another-skill", "Test", "test");
    const { status, data } = await request("POST", "/skills/upload", {}, {
      contentType: "multipart/form-data; boundary=----TestBoundary",
    });
    await cleanupFile(zipPath);

    if (status === 200) throw new Error(`Expected non-200 status, got ${status}`);
  });

  await test("Authorize skill globally (POST /skills/authorize)", async () => {
    const { status, data } = await request("POST", "/skills/authorize", {
      skillName: testSkillName,
      category: testCategory,
    });

    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!data.success) throw new Error(`Expected success=true`);
    if (data.scope !== "global") throw new Error(`Expected scope="global", got ${data.scope}`);
    if (!data.linkPath) throw new Error(`Expected linkPath in response`);
  });

  await test("Authorize skill for user (POST /skills/authorize)", async () => {
    const { status, data } = await request("POST", "/skills/authorize", {
      skillName: testSkillName,
      category: testCategory,
      target: TEST_USER_ID,
    });

    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!data.success) throw new Error(`Expected success=true`);
    if (data.scope !== "user") throw new Error(`Expected scope="user", got ${data.scope}`);
    if (data.target !== TEST_USER_ID) throw new Error(`Expected target="${TEST_USER_ID}", got ${data.target}`);
  });

  await test("Authorize fails for non-existent skill", async () => {
    const { status } = await request("POST", "/skills/authorize", {
      skillName: "non-existent-skill-xyz",
      category: "non-existent-category",
    });

    if (status !== 404) throw new Error(`Expected status 404, got ${status}`);
  });

  await test("Deauthorize skill for user (DELETE /skills/authorize)", async () => {
    const { status, data } = await request("DELETE", "/skills/authorize", {
      skillName: testSkillName,
      target: TEST_USER_ID,
    });

    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!data.success) throw new Error(`Expected success=true`);
    if (data.scope !== "user") throw new Error(`Expected scope="user", got ${data.scope}`);
  });

  await test("Deauthorize skill globally (DELETE /skills/authorize)", async () => {
    const { status, data } = await request("DELETE", "/skills/authorize", {
      skillName: testSkillName,
    });

    if (status !== 200) throw new Error(`Expected status 200, got ${status}`);
    if (!data.success) throw new Error(`Expected success=true`);
    if (data.scope !== "global") throw new Error(`Expected scope="global", got ${data.scope}`);
  });

  await test("Deauthorize fails without skillName", async () => {
    const { status } = await request("DELETE", "/skills/authorize", {});

    if (status === 200) throw new Error(`Expected non-200 status, got ${status}`);
  });

  console.log();
  console.log("=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nCleanup (may fail if skills don't exist):");
    await cleanupTestSkill(testSkillName, testCategory);
  }

  process.exit(failed > 0 ? 1 : 0);
}

console.log("Waiting for server to be ready...");
waitForServer()
  .then(() => {
    console.log("Server is ready, running tests...\n");
    return runTests();
  })
  .catch((e) => {
    console.error("Failed to connect to server:", e.message);
    console.error("Make sure the HTTP server is running with: pi --mode http");
    process.exit(1);
  });