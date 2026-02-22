/**
 * Database error helpers.
 */

/**
 * Check whether an error is caused by a unique-constraint violation.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUniqueViolation(error) {
  if (!error || typeof error !== 'object') return false;

  const code = error.code;
  if (code === '23505') return true;

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('duplicate key') || message.includes('unique constraint');
}
