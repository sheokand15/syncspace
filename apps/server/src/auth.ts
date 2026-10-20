import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';

const COOKIE = 'syncspace_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type AuthUser = { id: string; email: string; name: string };
declare module 'fastify' { interface FastifyRequest { authUser: AuthUser | null; csrfToken: string | null } }
export async function attachAuth(request: FastifyRequest) {
  request.authUser = null; request.csrfToken = null;
  const raw = request.cookies[COOKIE]; if (!raw) return;
  const result = await pool.query<{id:string;email:string;name:string;csrf_token:string}>(
    `SELECT u.id,u.email,u.name,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()`, [digest(raw)],
  );
  if (result.rowCount) { const row = result.rows[0]!; request.authUser = { id: row.id, email: row.email, name: row.name }; request.csrfToken = row.csrf_token; }
}
export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  if (!request.authUser) { void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }); return null; }
  return request.authUser;
}
export function requireCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
  const supplied = request.headers['x-csrf-token'];
  if (!request.csrfToken || typeof supplied !== 'string' || supplied !== request.csrfToken) { void reply.code(403).send({ error: { code: 'CSRF_FAILED', message: 'Refresh your session and try again.' } }); return false; }
  return true;
}
export async function createSession(userId: string, reply: FastifyReply) {
  const raw = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO sessions(id,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval \'14 days\')', [digest(raw), userId, csrf]);
  reply.setCookie(COOKIE, raw, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 14 });
  return csrf;
}
export async function removeSession(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies[COOKIE]; if (raw) await pool.query('DELETE FROM sessions WHERE id=$1', [digest(raw)]);
  reply.clearCookie(COOKIE, { path: '/' });
}
