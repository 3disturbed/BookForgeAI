import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { NotAuthorizedError } from '../domain/errors.js';
import * as repo from '../store/repo.js';

const COOKIE = 'bf_session';

let sessionSecret: Buffer | null = null;
function secret(): Buffer {
  if (!sessionSecret) {
    sessionSecret = process.env.SESSION_SECRET
      ? Buffer.from(process.env.SESSION_SECRET, 'utf8')
      : randomBytes(32);
  }
  return sessionSecret;
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('hex');
}

export function issueSession(res: Response, userId: string): void {
  const token = `${userId}.${sign(userId)}`;
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function currentUserId(req: Request): string | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;

  const index = token.lastIndexOf('.');
  if (index <= 0) return null;

  const userId = token.slice(0, index);
  const provided = Buffer.from(token.slice(index + 1), 'utf8');
  const expected = Buffer.from(sign(userId), 'utf8');
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? userId : null;
}

/** All project routes run behind this. */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  const userId = currentUserId(req);
  if (!userId) {
    next(new NotAuthorizedError('session'));
    return;
  }
  res_locals(req).userId = userId;
  next();
}

/** Per-request state without widening the Express type globally. */
const requestState = new WeakMap<Request, { userId: string }>();
function res_locals(req: Request): { userId: string } {
  let state = requestState.get(req);
  if (!state) {
    state = { userId: '' };
    requestState.set(req, state);
  }
  return state;
}

export function userIdOf(req: Request): string {
  const state = requestState.get(req);
  if (!state?.userId) throw new NotAuthorizedError('session');
  return state.userId;
}

/**
 * SECURITY.md: every project query is scoped to its owner. Loading a project
 * any other way is a bug.
 */
export function ownedProject(req: Request, projectId: string): repo.ProjectRow {
  const project = repo.getProject(projectId);
  if (!project || project.userId !== userIdOf(req)) {
    throw new NotAuthorizedError(`project ${projectId}`);
  }
  return project;
}
