import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { logger } from './logger'

const SALT_ROUNDS = 12

// P0-1 FIX: Prevent hardcoded dev secret from leaking to production
// Generate ephemeral secret for dev only - never reuse a static fallback
let ephemeralDevSecret: string | null = null

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: JWT_SECRET environment variable is required in production')
    }
    
    // Generate ephemeral secret for dev only - log warning
    if (!ephemeralDevSecret) {
      ephemeralDevSecret = crypto.randomBytes(32).toString('hex')
    logger.warn('[Auth] WARNING: Using ephemeral JWT secret - DO NOT USE IN PRODUCTION')
    logger.warn('[Auth] Set JWT_SECRET environment variable for persistent sessions')
    }
    return ephemeralDevSecret
  }
  
  return secret
}

// Lazy initialization to allow environment variables to be loaded
let JWT_SECRET: string | null = null

function getSecret(): string {
  if (!JWT_SECRET) {
    JWT_SECRET = getJwtSecret()
  }
  return JWT_SECRET
}

/**
 * Hashes a plain text password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

/**
 * Compares a plain text password with a hashed password.
 */
export async function comparePasswords(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/** Shape of data allowed in JWT tokens */
export interface JwtTokenPayload {
  userId: string
  role?: string
}

/**
 * Generates a JWT token for a user.
 */
export function generateToken(payload: JwtTokenPayload): string {
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn: '7d' })
}

/**
 * Verifies a JWT token.
 */
export function verifyToken(token: string): (JwtTokenPayload & jwt.JwtPayload) | null {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as JwtTokenPayload & jwt.JwtPayload
  } catch (error: unknown) {
    return null
  }
}
