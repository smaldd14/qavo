import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import type { RunReport } from "./report.ts";

export interface UploadConfig {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
}

function validPath(path: string) {
  return path === path.trim() && path.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && part === part.trim());
}

export function parseUploadConfig(env: NodeJS.ProcessEnv = process.env): UploadConfig | undefined {
  const { QAVO_S3_ENDPOINT: endpoint, QAVO_S3_BUCKET: bucket, QAVO_S3_REGION: region = "auto", QAVO_S3_PREFIX: prefix = "" } = env;
  if ([endpoint, bucket, env.QAVO_S3_REGION, env.QAVO_S3_PREFIX].every((value) => value === undefined)) return undefined;
  if (!endpoint || !bucket) throw new Error("Upload requires QAVO_S3_ENDPOINT and QAVO_S3_BUCKET.");

  const parts = /^https:\/\/([^/\s\\@?#]+)(\/[^\s\\?#]*)?$/.exec(endpoint);
  const endpointPath = (parts?.[2] ?? "").replace(/^\//, "").replace(/\/$/, "");
  if (!parts || parts[0] !== endpoint || parts[2] === "//" || (endpointPath && !validPath(endpointPath))) {
    throw new Error("QAVO_S3_ENDPOINT must use HTTPS without userinfo, query, fragment, or unsafe path segments.");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("QAVO_S3_ENDPOINT must be a valid HTTPS URL.");
  }
  if (bucket !== bucket.trim() || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw new Error("QAVO_S3_BUCKET must be a valid bucket name.");
  }
  if (region !== region.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) throw new Error("QAVO_S3_REGION is invalid.");
  const normalizedPrefix = prefix.replace(/\/$/, "");
  if (prefix && (!normalizedPrefix || !validPath(normalizedPrefix))) {
    throw new Error("QAVO_S3_PREFIX must contain safe relative path segments.");
  }
  if (!env.AWS_ACCESS_KEY_ID?.trim() || !env.AWS_SECRET_ACCESS_KEY?.trim()) {
    throw new Error("Upload requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
  }
  if (env.AWS_SESSION_TOKEN !== undefined && !env.AWS_SESSION_TOKEN.trim()) {
    throw new Error("AWS_SESSION_TOKEN must not be empty when provided.");
  }
  return { endpoint: url.href.replace(/\/$/, ""), bucket, region, prefix: normalizedPrefix };
}

export async function uploadRunArtifacts(
  dir: string,
  report: RunReport,
  config: UploadConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const validated = parseUploadConfig({
    QAVO_S3_ENDPOINT: config.endpoint,
    QAVO_S3_BUCKET: config.bucket,
    QAVO_S3_REGION: config.region,
    QAVO_S3_PREFIX: config.prefix,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
  })!;
  if (!validPath(report.id) || report.id.includes("/")) throw new Error("The run ID is invalid for upload.");
  const screenshots = new Set<string>();
  for (const step of report.steps) {
    for (const turn of step.turns) {
      if (turn.screenshot === undefined) continue;
      if (turn.screenshot !== turn.screenshot.trim() || !/^step[1-9]\d*-turn(?:0[1-9]|[1-9]\d+)\.jpg$/.test(turn.screenshot)) {
        throw new Error("The report contains an invalid screenshot filename.");
      }
      screenshots.add(turn.screenshot);
    }
  }
  const filenames = [...screenshots, "report.json"];
  const keyPrefix = [validated.prefix, report.id].filter(Boolean).join("/");
  try {
    if (!(await lstat(dir)).isDirectory()) throw new Error();
    const directory = await realpath(dir);
    for (const filename of filenames) {
      if (!(await lstat(join(directory, filename))).isFile()) throw new Error();
    }
    const client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      sessionToken: env.AWS_SESSION_TOKEN,
      region: validated.region,
      service: "s3",
      retries: 0,
    });
    for (const filename of filenames) {
      const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let body: Uint8Array<ArrayBuffer>;
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        body = new Uint8Array(await file.readFile());
      } finally {
        await file.close();
      }
      const request = await client.sign(`${validated.endpoint}/${validated.bucket}/${keyPrefix}/${filename}`, {
        method: "PUT",
        body,
        headers: { "content-type": filename === "report.json" ? "application/json" : "image/jpeg" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const response = await fetch(request);
      await response.body?.cancel();
      if (!response.ok) throw new Error();
    }
  } catch {
    throw new Error("Artifact upload failed. Local files were preserved.");
  }
  return `s3://${validated.bucket}/${keyPrefix}/report.json`;
}
