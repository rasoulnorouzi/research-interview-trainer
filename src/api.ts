/// <reference types="vite/client" />

// Same origin by default: the Worker serves both the app and /api/*, so there
// is no CORS anywhere. The env var exists so pointing the client at a
// university-hosted backend later is a config change, not a code change
// (BACKEND-PLAN §9).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** JSON fetch against the backend. Throws ApiError carrying the server's own message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
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
