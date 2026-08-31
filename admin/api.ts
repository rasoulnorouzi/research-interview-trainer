/// <reference types="vite/client" />

// Mirrors src/api.ts. The only difference is the path prefix: every admin
// route lives under /api/admin (worker/admin.ts, BACKEND-PLAN.md §4/§7).
//
// Cloudflare Access authenticates the browser before this page is ever
// reached — an unauthenticated visitor is redirected to the Access login
// page, not served admin.html. The Worker then verifies the resulting
// Cf-Access-Jwt-Assertion header on every /api/admin/* request
// (worker/access.ts). This module never sees or handles auth itself; it
// only carries the session cookie / Access cookie via `credentials: "include"`.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const ADMIN_PREFIX = "/api/admin";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** JSON fetch against the admin API. `path` is relative to /api/admin, e.g. "/settings". */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + ADMIN_PREFIX + path, {
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your network connection.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body.error === "string"
        ? body.error
        : `The server returned an error (HTTP ${res.status}).`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/**
 * Same as api<T>, for the one admin endpoint that answers bytes instead of
 * JSON: POST /api/admin/voice-preview. Errors still arrive as JSON and are
 * thrown the same way.
 */
export async function apiBlob(path: string, init?: RequestInit): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(API_BASE + ADMIN_PREFIX + path, {
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your network connection.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body.error === "string"
        ? body.error
        : `The server returned an error (HTTP ${res.status}).`;
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

/**
 * A non-fetch admin URL, for the one endpoint the browser needs as a plain
 * link rather than a JSON call: GET /api/admin/submissions.csv. The browser
 * carries the Access cookie on a normal navigation the same way it does on
 * fetch, so no extra plumbing is needed here.
 */
export function adminUrl(path: string): string {
  return API_BASE + ADMIN_PREFIX + path;
}
