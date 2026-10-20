import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { attachAuth, createSession, removeSession, requireCsrf, requireUser } from './auth.js';
import { handleCollaborationSocket, persistenceIsHealthy, revokeRoomSockets } from './collaboration.js';

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: process.env.NODE_ENV === 'production' });
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
function revokeSockets(documentId:string,userId?:string){revokeRoomSockets(documentId,userId);}
await app.register(cookie);
await app.register(cors, { origin: webOrigin, credentials: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
app.addHook('preHandler', attachAuth);

const fail = (reply: typeof app extends never ? never : import('fastify').FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const registerSchema = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(254).transform(s=>s.toLowerCase()), password: z.string().min(8).max(128) });
const loginSchema = z.object({ email: z.string().email().transform(s=>s.toLowerCase()), password: z.string().min(1).max(128) });
const titleSchema = z.object({ title: z.string().trim().min(1).max(160) });
const documentSchema = z.object({ title: z.string().trim().min(1).max(160).default('Untitled document') });

app.get('/api/health', async () => ({ status: 'ok' }));
app.get('/api/ready', async (_req, reply) => { try { await pool.query('SELECT 1'); if(!persistenceIsHealthy())return fail(reply,503,'PERSISTENCE_DEGRADED','Document persistence has reported a write failure.'); return { status:'ready' }; } catch { return fail(reply,503,'NOT_READY','Database is unavailable.'); } });
app.post('/api/auth/register', {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (req, reply) => {
  const parsed = registerSchema.safeParse(req.body); if (!parsed.success) return fail(reply,400,'INVALID_INPUT','Enter a name, valid email, and password of at least 8 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const {name,email,password}=parsed.data; const hash=await bcrypt.hash(password,12);
    const user=await client.query<{id:string;name:string;email:string}>('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email',[name,email,hash]);
    const workspace=await client.query<{id:string}>('INSERT INTO workspaces(name,owner_id) VALUES($1,$2) RETURNING id',[`${name}'s workspace`,user.rows[0]!.id]);
    await client.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,\'owner\')',[workspace.rows[0]!.id,user.rows[0]!.id]); await client.query('COMMIT');
    const csrfToken=await createSession(user.rows[0]!.id,reply); return reply.code(201).send({user:user.rows[0],csrfToken});
  } catch(error) { await client.query('ROLLBACK'); if ((error as {code?:string}).code==='23505') return fail(reply,409,'EMAIL_EXISTS','An account already exists for this email.'); throw error; } finally { client.release(); }
});
app.post('/api/auth/login', {config:{rateLimit:{max:10,timeWindow:'1 minute'}}}, async (req,reply)=>{const parsed=loginSchema.safeParse(req.body);if(!parsed.success)return fail(reply,400,'INVALID_INPUT','Enter a valid email and password.');const result=await pool.query<{id:string;name:string;email:string;password_hash:string}>('SELECT id,name,email,password_hash FROM users WHERE email=$1',[parsed.data.email]);const row=result.rows[0];if(!row||!await bcrypt.compare(parsed.data.password,row.password_hash))return fail(reply,401,'INVALID_CREDENTIALS','Email or password is incorrect.');const csrfToken=await createSession(row.id,reply);return {user:{id:row.id,name:row.name,email:row.email},csrfToken};});
app.post('/api/auth/logout',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;await removeSession(req,reply);return reply.code(204).send();});
app.get('/api/auth/me',async(req,reply)=>{if(!requireUser(req,reply))return;return {user:req.authUser,csrfToken:req.csrfToken};});
app.get('/api/workspaces',async(req,reply)=>{if(!requireUser(req,reply))return;const r=await pool.query('SELECT w.id,w.name,w.owner_id AS "ownerId",w.created_at AS "createdAt" FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at',[req.authUser!.id]);return {workspaces:r.rows};});
app.post('/api/workspaces',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const schema=z.object({name:z.string().trim().min(1).max(100)});const p=schema.safeParse(req.body);if(!p.success)return fail(reply,400,'INVALID_INPUT','Workspace name must be 1–100 characters.');const c=await pool.connect();try{await c.query('BEGIN');const w=await c.query('INSERT INTO workspaces(name,owner_id) VALUES($1,$2) RETURNING id,name,owner_id AS "ownerId",created_at AS "createdAt"',[p.data.name,req.authUser!.id]);await c.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w.rows[0]!.id,req.authUser!.id]);await c.query('COMMIT');return reply.code(201).send({workspace:w.rows[0]});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
app.get('/api/documents',async(req,reply)=>{if(!requireUser(req,reply))return;const r=await pool.query(`SELECT DISTINCT d.id,d.title,d.workspace_id AS "workspaceId",d.created_at AS "createdAt",d.updated_at AS "updatedAt",u.name AS "ownerName" FROM documents d JOIN users u ON u.id=d.created_by LEFT JOIN workspace_members wm ON wm.workspace_id=d.workspace_id LEFT JOIN document_members dm ON dm.document_id=d.id WHERE d.deleted_at IS NULL AND (wm.user_id=$1 OR dm.user_id=$1) ORDER BY d.updated_at DESC LIMIT 100`,[req.authUser!.id]);return {documents:r.rows};});
app.post('/api/documents',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const p=documentSchema.safeParse(req.body);if(!p.success)return fail(reply,400,'INVALID_INPUT','Document title must be 1–160 characters.');const c=await pool.connect();try{await c.query('BEGIN');let ws=await c.query<{workspace_id:string}>('SELECT workspace_id FROM workspace_members WHERE user_id=$1 ORDER BY joined_at LIMIT 1',[req.authUser!.id]);if(!ws.rowCount){const created=await c.query<{id:string}>('INSERT INTO workspaces(name,owner_id) VALUES($1,$2) RETURNING id',[`${req.authUser!.name}'s workspace`,req.authUser!.id]);await c.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[created.rows[0]!.id,req.authUser!.id]);ws={...ws,rows:[{workspace_id:created.rows[0]!.id}],rowCount:1};}const r=await c.query('INSERT INTO documents(workspace_id,created_by,title) VALUES($1,$2,$3) RETURNING id,title,workspace_id AS "workspaceId",created_at AS "createdAt",updated_at AS "updatedAt"',[ws.rows[0]!.workspace_id,req.authUser!.id,p.data.title]);await c.query('COMMIT');return reply.code(201).send({document:r.rows[0]});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
async function access(documentId:string,userId:string){return pool.query<{permission:string;is_owner:boolean}>('SELECT CASE WHEN d.created_by=$2 THEN \'edit\' ELSE COALESCE(dm.permission,\'edit\') END AS permission,(d.created_by=$2) AS is_owner FROM documents d LEFT JOIN document_members dm ON dm.document_id=d.id AND dm.user_id=$2 LEFT JOIN workspace_members wm ON wm.workspace_id=d.workspace_id AND wm.user_id=$2 WHERE d.id=$1 AND d.deleted_at IS NULL AND (d.created_by=$2 OR dm.user_id=$2 OR wm.user_id=$2) LIMIT 1',[documentId,userId]);}
app.get('/api/documents/:documentId',async(req,reply)=>{if(!requireUser(req,reply))return;const {documentId}=req.params as {documentId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');const r=await pool.query('SELECT id,title,workspace_id AS "workspaceId",created_at AS "createdAt",updated_at AS "updatedAt",created_by AS "ownerId" FROM documents WHERE id=$1 AND deleted_at IS NULL',[documentId]);return {document:r.rows[0],permission:a.rows[0]!.permission,isOwner:a.rows[0]!.is_owner};});
app.patch('/api/documents/:documentId',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const {documentId}=req.params as {documentId:string};const p=titleSchema.safeParse(req.body);if(!p.success)return fail(reply,400,'INVALID_INPUT','Document title must be 1–160 characters.');const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');if(a.rows[0]!.permission!=='edit')return fail(reply,403,'FORBIDDEN','You have read-only access.');const r=await pool.query('UPDATE documents SET title=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,title,workspace_id AS "workspaceId",created_at AS "createdAt",updated_at AS "updatedAt"',[documentId,p.data.title]);return {document:r.rows[0]};});
app.delete('/api/documents/:documentId',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const {documentId}=req.params as {documentId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');if(!a.rows[0]!.is_owner)return fail(reply,403,'FORBIDDEN','Only the document owner can delete it.');await pool.query('UPDATE documents SET deleted_at=now(),updated_at=now() WHERE id=$1',[documentId]);revokeSockets(documentId);return reply.code(204).send();});
app.get('/api/documents/:documentId/collaborators',async(req,reply)=>{if(!requireUser(req,reply))return;const {documentId}=req.params as {documentId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');const r=await pool.query(`SELECT u.id,u.name,u.email,CASE WHEN d.created_by=u.id THEN 'owner' ELSE dm.permission END AS permission FROM documents d JOIN users u ON u.id=d.created_by LEFT JOIN document_members dm ON dm.document_id=d.id WHERE d.id=$1 UNION SELECT u.id,u.name,u.email,dm.permission FROM document_members dm JOIN users u ON u.id=dm.user_id WHERE dm.document_id=$1`,[documentId]);return {collaborators:r.rows};});
app.post('/api/documents/:documentId/collaborators',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const {documentId}=req.params as {documentId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');if(!a.rows[0]!.is_owner)return fail(reply,403,'FORBIDDEN','Only the document owner can share it.');const p=z.object({email:z.string().email().transform(s=>s.toLowerCase()),permission:z.enum(['read','edit'])}).safeParse(req.body);if(!p.success)return fail(reply,400,'INVALID_INPUT','Enter an email and read or edit permission.');const u=await pool.query<{id:string;name:string;email:string}>('SELECT id,name,email FROM users WHERE email=$1',[p.data.email]);if(!u.rowCount)return fail(reply,404,'USER_NOT_FOUND','No SyncSpace account was found for that email.');await pool.query('INSERT INTO document_members(document_id,user_id,permission) VALUES($1,$2,$3) ON CONFLICT(document_id,user_id) DO UPDATE SET permission=excluded.permission',[documentId,u.rows[0]!.id,p.data.permission]);revokeSockets(documentId,u.rows[0]!.id);return reply.code(201).send({collaborator:{...u.rows[0],permission:p.data.permission}});});
app.patch('/api/documents/:documentId/collaborators/:userId',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const {documentId,userId}=req.params as {documentId:string;userId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');if(!a.rows[0]!.is_owner)return fail(reply,403,'FORBIDDEN','Only the document owner can manage access.');const p=z.object({permission:z.enum(['read','edit'])}).safeParse(req.body);if(!p.success)return fail(reply,400,'INVALID_INPUT','Permission must be read or edit.');const updated=await pool.query('UPDATE document_members SET permission=$3 WHERE document_id=$1 AND user_id=$2 RETURNING user_id',[documentId,userId,p.data.permission]);if(!updated.rowCount)return fail(reply,404,'NOT_FOUND','Collaborator not found.');revokeSockets(documentId,userId);return {collaborator:{userId,permission:p.data.permission}};});
app.delete('/api/documents/:documentId/collaborators/:userId',async(req,reply)=>{if(!requireUser(req,reply)||!requireCsrf(req,reply))return;const {documentId,userId}=req.params as {documentId:string;userId:string};const a=await access(documentId,req.authUser!.id);if(!a.rowCount)return fail(reply,404,'NOT_FOUND','Document not found.');if(!a.rows[0]!.is_owner)return fail(reply,403,'FORBIDDEN','Only the document owner can manage access.');await pool.query('DELETE FROM document_members WHERE document_id=$1 AND user_id=$2',[documentId,userId]);revokeSockets(documentId,userId);return reply.code(204).send();});

app.get('/collaboration/:documentId',{websocket:true},async(socket,req)=>{
  const {documentId}=req.params as {documentId:string};
  if(!req.authUser){socket.close(1008,'Sign in required');return;}
  const a=await access(documentId,req.authUser.id);
  if(!a.rowCount){socket.close(1008,'Document access denied');return;}
  await handleCollaborationSocket(socket as unknown as import('ws').WebSocket,req,documentId,req.authUser,a.rows[0]!.permission as 'read'|'edit',webOrigin);
});

if(process.env.NODE_ENV==='production'){
  const webRoot=resolve(fileURLToPath(new URL('.',import.meta.url)),'../../web/dist');
  const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
  app.get('/*',async(req,reply)=>{
    const path=decodeURIComponent((req.params as {'*':string})['*']??'');
    if(path.startsWith('api/')||path.startsWith('collaboration/'))return fail(reply,404,'NOT_FOUND','Resource not found.');
    const target=resolve(webRoot,path);
    const rootPrefix=webRoot+(process.platform==='win32'?'\\':'/');
    if(target!==webRoot&&!target.startsWith(rootPrefix))return fail(reply,404,'NOT_FOUND','Resource not found.');
    try{const info=await stat(target);if(!info.isFile())throw new Error('not a file');return reply.type(mime[extname(target)]??'application/octet-stream').send(createReadStream(target));}
    catch{return reply.type('text/html; charset=utf-8').send(createReadStream(join(webRoot,'index.html')));}
  });
  app.get('/',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(createReadStream(join(webRoot,'index.html'))));
}

app.setErrorHandler((error,_req,reply)=>{app.log.error({err:error},'request failed');const statusCode=(error as {statusCode?:number}).statusCode;const status=statusCode&&statusCode>=400&&statusCode<500?statusCode:500;return fail(reply,status,status===500?'INTERNAL_ERROR':'INVALID_REQUEST',status===500?'An unexpected error occurred.':'The request could not be processed.');});
const port=Number(process.env.PORT??3001);
try{await app.listen({port,host:'0.0.0.0'});}catch(error){app.log.error(error);process.exit(1);}
const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
