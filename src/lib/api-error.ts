/**
 * API Error Handling Utilities
 * 
 * P2 #9 FIX: Consolidate ApiError classes.
 * This is the source of truth for API errors across both client and server.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Keep APIError as a deprecated alias for backward compatibility if needed, 
// but encourage migration to ApiError.
export { ApiError as APIError };

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export async function fetchWithErrorHandling<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(url, options)

    if (!response.ok) {
      let errorMessage = `HTTP error ${response.status}`
      let errorCode: string | undefined

      try {
        const errorData = await response.json()
        // Handle both flat and nested error formats
        errorMessage = errorData.error?.message || errorData.error || errorData.message || errorMessage
        errorCode = errorData.error?.code || errorData.code
      } catch {
        // Response is not JSON
      }

      throw new ApiError(errorMessage, response.status, errorCode)
    }

    return response.json()
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      throw error
    }

    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new ApiError(
        "Network error. Please check your connection.",
        0,
        "NETWORK_ERROR"
      )
    }

    throw new ApiError(
      error instanceof Error ? error.message : "An unexpected error occurred",
      500,
      "UNKNOWN_ERROR"
    )
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.statusCode) {
      case 400:
        return error.message || "Invalid request"
      case 401:
        return "Please sign in to continue"
      case 403:
        return "You don't have permission to do this"
      case 404:
        return error.message || "Not found"
      case 409:
        return error.message || "This action conflicts with existing data"
      case 429:
        return "Too many requests. Please wait a moment."
      case 500:
        return "Server error. Please try again later."
      default:
        return error.message || "Something went wrong"
    }
  }

  if (error instanceof Error) {
    return error.message
  }

  return "An unexpected error occurred"
}

export function handleAPIError(error: unknown, fallback?: string): never {
  const message = getErrorMessage(error)
  throw new Error(fallback || message)
}

/**
 * Retry utility for failed requests
 */
export async function fetchWithRetry<T>(
  url: string,
  options?: RequestInit & { retries?: number; retryDelay?: number }
): Promise<T> {
  const { retries = 3, retryDelay = 1000, ...fetchOptions } = options || {}

  let lastError: Error | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithErrorHandling<T>(url, fetchOptions)
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't retry on client errors (4xx) except 429
      if (error instanceof ApiError) {
        if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
          throw error
        }
      }

      if (attempt < retries) {
        // Exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay * Math.pow(2, attempt))
        )
      }
    }
  }

  throw lastError
}
