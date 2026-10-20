// Shared helpers for route handlers: auth, JSON parsing, and mapping database
// errors to safe HTTP responses (no stack traces or peer data leak).
import "server-only";
import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new ApiError(401, "Sign in required");
  return { supabase, user: data.user };
}

export async function requireAdmin() {
  const ctx = await requireUser();
  const { data } = await ctx.supabase.rpc("is_admin");
  if (!data) throw new ApiError(403, "Admin only");
  return ctx;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function parseBody<T extends ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try { json = await req.json(); } catch { throw new ApiError(400, "Invalid JSON"); }
  const r = schema.safeParse(json);
  if (!r.success) throw new ApiError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

type PgError = { code?: string; message?: string };

export function fromRpcError(error: PgError): ApiError {
  // Postgres error codes raised in our functions
  if (error.code === "42501") return new ApiError(403, "Not allowed");
  if (error.code === "P0002") return new ApiError(429, "Too many requests, slow down a little");
  if (error.code === "P0001") return new ApiError(409, error.message ?? "Not possible right now");
  if (error.code === "23505") return new ApiError(409, "Already exists");
  console.error("[api] rpc error", error.code, error.message);
  return new ApiError(500, "Something went wrong");
}

export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((e) => {
    if (e instanceof ApiError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api] unhandled", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  });
}

export const ok = (data: unknown = { ok: true }) => NextResponse.json(data);
